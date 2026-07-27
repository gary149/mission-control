# mission-control

A control plane for delegated agent runs. `mc` makes "run this task on any coding-agent
harness, on any model, on any of my machines" a tracked, verified, push-notified primitive
instead of bash-over-SSH glue.

```
mc run --harness codex --model gpt-5.5 --cwd ~/code/foo --budget 5 "implement X, artifact: dist/app.js"
mc ls                        # what's running, everywhere
mc tail 0h4x                 # live event stream of one run
mc resume 0h4x "also add tests"
```

## What it is not

- **Not a chat gateway.** OpenClaw, NanoClaw, Telegram bots etc. are delivery channels and
  callers. mc never owns a channel and never imports claw code.
- **Not an agent loop.** mc has no resident model and makes no decisions. The "main agent"
  is whoever drives it: you at a terminal, a Claude Code session via MCP, or any claw's
  agent shelling out to the CLI.
- **Not a session browser.** agentsview owns history, search, and cost analytics across
  harnesses. mc converges on its conventions but does not depend on it (see below).
- **Not a model-picker.** You (or the orchestrating agent) name the harness and model per
  run. There is no automatic selection policy.

## Why (evidence)

Distilled from 22 Claude Code sessions (May-Jul 2026) driving delegated work on OpenClaw's
Hetzner box, plus deep reads of openclaw, omnigent, nanoclaw, pi-mono, agentsview:

1. **Self-reported success is routinely false.** Five independent incidents of an agent or
   bot claiming success that hadn't happened (a "VERIFIED" with zero renders; "Live on HF
   Space" that was a login wall; a claimed relaunch where every attempt had errored).
   Completion must be independently checked, never trusted.
2. **"Is it running?" required archaeology.** 20+ manual status checks, each an SSH
   round-trip plus grep over raw JSONL, across three run stacks with three different
   status conventions.
3. **Finished work got lost silently.** A paid run sat undelivered for 90+ minutes because
   its watcher died with stderr piped to /dev/null; a 12-hour polling loop died at tick 9
   and dropped the deliverable. Watchers must outlive chat sessions; stderr is never
   discarded; delivery is push, not poll.
4. **Ad hoc glue is the failure surface.** Inline SSH heredocs broke repeatedly on quoting;
   every delegation stack (ct.sh, run-task.sh, codex-monitor, tmux harnesses) was
   hand-rolled and each failed differently.
5. **Capability gaps are silent.** Claude Code strips `effort` for non-Anthropic models
   with no error; a broken codex resume flag silently started fresh sessions for ~97
   consecutive follow-ups. What a harness can actually do must be declared data, checked
   at launch.

## Decisions (locked 2026-07-20)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Identity | Pure control plane; no resident agent |
| 2 | Process model | Per-run detached supervisors; per-host SQLite ledger; no global daemon |
| 3 | Stack | TypeScript on Node >= 22.13; `node:sqlite`, zero runtime deps; committed tsc-emitted `dist/` shipped as an npm package with no install-time scripts (revised 2026-07-23, ADR 0002; was: Bun + compiled single binary) |
| 4 | Adapters | Wrap each CLI's native headless JSON mode; normalize to one closed event union |
| 5 | Verification | Two-axis status: `exit` x `verdict`; DONE = succeeded AND verified |
| 6 | Remote | Install per host; engine is SSH-free; driven via plain `ssh box mc ...` with specs over stdin (revised 2026-07-20, was: `--host` SSH sugar in mc) |
| 7 | Notifications | Generic per-host `on_terminal` hook (exec and/or webhook); Telegram example config |
| 8 | Follow-ups | `mc resume` = new run linked by `parent_run_id`, harness-native resume, capability-gated; inherits the parent's artifacts/visual/caps unless overridden (a continuation that silently drops its declared checks stops being verifiable). `mc resume --fresh [--at SHA]` = checkpoint restart: NEW worktree at a commit of the parent's repo, NEW session (for escaping stuck/degraded sessions); needs no resume capability. Same lineage either way |
| 9 | agentsview | Loose coupling: converge on conventions, store `session_id`, zero dependency |
| 10 | V1 adapters | claude-code, codex, pi (one per integration style: stream-json, exec-json, RPC) |
| 11 | Cost | Always record (unknown, never 0, when unparseable); opt-in per-run `--budget` kill; no global policy |
| 12 | Capabilities | Static typed declarations in each adapter (agentsview pattern); `mc harness ls`; refuse-loudly |
| 13 | Auth modes | Three per run: `subscription` (default, zero-config, CLI's own resident login), `api_key`, `gateway` (OpenRouter builtin). Child env built additively from empty, never inherited |
| 14 | Cost honesty | `cost_basis` field says whether a dollar figure is real, impossible, or absent; `--budget` refused where it can't fire; `--max-minutes` is the universal backstop; no shadow pricing |
| 15 | The edge | Launch-only: a Run exists iff mc launched it (ADR 0001). Run = one harness session (internal subagents roll up, never rows). Harness = agentic CLI with a workspace; bare API calls excluded. Hosts stand alone; no fleet concept. Verified = declared checks passed, nothing about quality. See CONTEXT.md for the glossary |

## Core model

### Run

One SQLite row per delegated task, one schema regardless of harness or host.

```ts
interface Run {
  id: string;                 // short, e.g. "0h4x"
  parent_run_id: string | null;   // set by `mc resume` and future nested spawns
  root_run_id: string;            // O(1) lineage queries (omnigent pattern)
  harness: string;                // "claude-code" | "codex" | "pi" | ...
  model: string | null;           // as passed to the harness
  host: string;                   // where it executed
  prompt: string;                 // what the operator asked for, verbatim
  title: string;                  // short human label, derived from the prompt at launch (UI rows)
  spec_path: string;              // the launch spec JSON, archived
  workdir: string;                // isolated per run, never shared, never the caller's cwd
  session_id: string | null;      // harness-native session id (agentsview jump point)

  exit: "queued" | "running" | "succeeded" | "failed" | "killed" | "lost";
  verdict: "pending" | "verified" | "failed_verification" | "unverifiable" | "needs_human_look";

  started_at: string; ended_at: string | null;
  cost_usd: number | null;        // null = unknown; never coerce to 0
  cost_basis: "flat_subscription" | "metered_reported" | "unavailable";  // WHY cost is null (see Auth & billing)
  tokens_in: number | null; tokens_out: number | null;
  budget_usd: number | null;      // opt-in kill threshold; refused where cost_basis can't support it
  max_minutes: number | null;     // opt-in wall-clock kill; the backstop where --budget is refused
  auth_mode: "subscription" | "api_key" | "gateway";
  gateway: string | null;         // gateway name when auth_mode === "gateway"
  pid: number | null;
  stderr_path: string;            // ALWAYS a real file
  artifacts: string[];            // declared expectations at launch; checked by verifier
  verify_evidence: string | null; // what the verifier actually observed
}
```

`exit` is what the process did. `verdict` is what we independently confirmed. The UI/CLI
renders DONE only for `succeeded + verified`; every other combination shows both axes.
The two are never conflated, because "the agent said done" has been wrong too often.

### Events

Append-only per-run stream in an `events` table (`run_id, seq, ts, kind, payload_json`),
fed by the adapter translating native output. Closed kind union:

```
started | text | tool_call | tool_result | subagent | turn_end | cost_update | artifact |
status_change | verify_result | notify_result | error | exited
```

Adapters must map into this union or emit `error`; unknown native events are stored raw
under `error` with a parse note, never dropped. This union is deliberately shaped so it
could become an RPC wire vocabulary later (pi-mono style) without a schema migration.

`subagent` carries internal task/subagent lifecycle as structured data
(`phase, task_id, description, status`) without violating the one-Run-per-lead-session
rule (ADR 0001): subagents still never become ledger rows; `mc tail` just gains a live
activity feed and an orchestrator can render the tree straight from the stream.
Currently emitted by claude-code (system subtypes `task_started | task_progress |
task_updated | task_notification | background_tasks_changed`, shapes captured live);
codex has no subagent events, pi's agent_* chatter is single-agent lifecycle, and
kimi-code's CLI never writes subagent events to stdout (upstream #2130).

### HarnessAdapter

One TS module per harness. No invented wire protocol in v1; each adapter wraps the CLI's
own headless mode:

- **claude-code**: `claude -p --output-format stream-json` (+ `--resume <session>` for resume)
- **codex**: `codex exec --json` (resume gated off until it smoke-tests clean)
- **kimi-code**: `kimi -p --output-format stream-json` (+ `--session <id>` for resume)
- **pi**: RPC mode, JSONL over stdio (`packages/coding-agent` rpc-client shape)

```ts
interface HarnessAdapter {
  name: string;
  capabilities: Capabilities;                    // static, typed, code-reviewed
  launch(spec: RunSpec): Promise<Handle>;        // spawn detached child, return pid + streams
  events(h: Handle): AsyncIterable<Event>;       // native output -> closed union
  isAlive(h: Handle): boolean;                   // informed by activity, not just pid (nanoclaw)
  result(h: Handle): Promise<RawResult>;         // exit code, cost/tokens if parseable
  kill(h: Handle): Promise<void>;
  resumeArgs?(sessionRef: string): string[];     // only if capabilities.resume === "native"
}

interface Capabilities {
  resume: "none" | "native";
  steering: "none";                              // v1: no adapter supports mid-run steering
  cost_reporting: "per_run" | "none";
  tokens_reporting: "reported" | "none";         // whether the native stream carries token counts at all
  effort_passthrough: "honored" | "stripped_for_non_anthropic" | "unknown";
  sandbox: "flag" | "none";
  auth_modes: ("subscription" | "api_key" | "gateway")[];
}
```

Rules:

- **Refuse loudly.** If a requested op isn't in the capability declaration, `mc` errors at
  launch naming the capability. Silent degradation is banned (the 97-follow-ups bug).
- **Fail to `unverifiable`, not to green.** When a native format drifts and parsing breaks,
  the run keeps running, events degrade to raw, and the verdict axis reflects the blindness.
- **Pin the binary.** The launch spec records the resolved absolute path + version of the
  harness CLI; the supervisor re-checks it before exec (auto-updater relocation broke the
  old runner twice).

### Plugging a new harness

An adapter is one module in `src/core/adapters/<name>.ts` exporting an `AdapterFactory`
(agentsview's ProviderFactory shape):

```ts
interface AdapterFactory {
  name: string;
  capabilities: Capabilities;         // static declaration, code-reviewed
  detect(): Promise<Detection>;       // is the CLI installed; resolved path + version
  create(config: AdapterConfig): HarnessAdapter;
}
```

Factories register in a static compile-time array (no dynamic plugin loading in v1).
`mc harness ls` shows every registered adapter with its capabilities and detection status
(installed/missing, path, version), so "registered but not runnable here" is visible
(omnigent's readiness-gating pattern). The checklist for a new adapter: find the CLI's
headless JSON mode; map native events into the closed union; extract cost/tokens or
declare `cost_reporting: "none"`; implement resume args or declare `resume: "none"`;
record fixtures (below). Target size: 100-200 lines plus fixtures.

### Golden invocations (running each harness optimally)

Correct parsing is not enough; each harness has a hard-won set of flags and env without
which runs are silently worse. The adapter owns this "golden invocation" as code — the
runbook knowledge currently scattered across skill files, made executable:

- **claude-code**: `-p --output-format stream-json --dangerously-skip-permissions`, run
  as a non-root user (claude refuses skip-permissions as root); pin
  `CLAUDE_CODE_SUBAGENT_MODEL` and the haiku-class model var whenever the main model is
  overridden (else subagents/background calls silently use a different model or 401);
  raise `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (headless background waits die at a
  hardcoded 10-minute ceiling with only a buried stderr line); disable the auto-updater
  for the run's child (`DISABLE_AUTOUPDATER=1`) — binary relocation mid-run broke the old
  delegation stack twice. In-session wakeup timers are NOT durable under `-p`: the
  process ends at end_turn and scheduled wakeups die with it, so a lead that ends its
  turn "expecting to be woken" silently stalls (documented live incident). Continuation
  is driven from OUTSIDE the session — notify hook → orchestrator → `mc resume` — never
  from inside it.
- **codex**: `exec --json` with the sandbox/approval flags resolved from the spec
  (`--yolo` only inside mc's isolated worktree), `model_reasoning_effort` mapped from
  `--effort`; task context injected via `AGENTS.md` in the workdir (codex's native
  context channel — the proven gist-injection pattern, generalized).
- **pi**: RPC mode; effort maps to the `:thinkingLevel` model suffix; session enabled
  (never `--no-session`) so `session_id` and resume stay possible.
- **kimi-code** (grounded in 0.29.2, probed live): `-p --output-format stream-json`,
  which is always full-auto (no permission-bypass flag exists or is accepted; kimi
  force-approves every tool call in prompt mode). The CLI ignores conventional
  credential env vars entirely; the only env channel is the `KIMI_MODEL_*` family
  (`KIMI_MODEL_NAME`, `KIMI_MODEL_API_KEY`, `KIMI_MODEL_PROVIDER_TYPE`,
  `KIMI_MODEL_BASE_URL`), which synthesizes an in-memory provider+model per run -
  nothing secret written to disk. `KIMI_CODE_HOME` is pointed at a per-run scratch
  sibling of the workdir (state isolation; resume runs reuse the parent's workdir and
  therefore its sessions). A model is REQUIRED in both supported auth modes (the
  scratch home has no `default_model`), refused by name at preflight. The stream has
  no session-start, no turn-complete, and no token/cost telemetry; the trailing
  `session.resume_hint` meta line is the only end-of-run marker and doubles as
  `turn_end` + session capture - if kimi drops it (upstream #1897, signal shutdown),
  the run degrades to `unverifiable`, the correct fail direction. Failures exit 1
  with an empty stdout. Subscription (Kimi OAuth) is deferred until a real
  `kimi login` exists to verify the credential layout against.

Two mechanisms keep this honest:

1. **Spec-to-native translation is total or refused.** `--effort`, `--visual`, declared
   artifacts, and the prompt text are translated into each harness's native equivalents
   (effort → env/config/suffix; artifacts → an appended one-line contract in the prompt:
   "write outputs to <paths>"). If a spec field has no native equivalent and no safe
   default, mc refuses by name — never silently drops (decision #12's rule, applied to
   invocation, which is exactly how the effort-stripping trap stayed invisible for so
   long upstream).
2. **Golden invocations are tested like everything else.** The conformance fixtures are
   recorded *through* the golden invocation, and `mc harness check` asserts its
   load-bearing pieces (subagent-model pinning took effect, updater disabled, AGENTS.md
   was read). When a better recipe is found, the adapter changes in one place and every
   caller inherits it.

Out of scope for v1 but noted: `mc harness bench` — running one canonical task across
harnesses/models/settings and comparing verification pass rate, cost, and wall time
(omnigent's harness_bench pattern). Deferred until the tracking spine has real usage data.

### Adapter conformance (how we trust adapters)

"Perfectly implemented" is not achievable against drifting vendor CLIs (documented:
codex's `--json` changed shape; OpenRouter's shim emitted empty results). What is
achievable is (a) a guaranteed failure direction and (b) three verification layers:

0. **Failure direction.** A broken adapter must degrade to raw-preserved events and an
   `unverifiable` verdict, never to a false DONE. This invariant is the one every layer
   below actually tests.
1. **Compile-time contract.** Every factory satisfies the TS interfaces; the event union
   and capability enums are closed types (agentsview's backendcontract, for free in TS).
2. **Shared conformance suite over recorded fixtures.** Each adapter ships captured real
   native output under `fixtures/<harness>/<cli-version>/`: a successful run, a failing
   run, a resumed run, a cost-bearing result, and a truncated/malformed stream. ONE
   parameterized test battery replays every fixture through every adapter and asserts the
   invariants: exactly one `started` and one terminal event; no dropped lines (unknown
   input lands as raw `error` events); cost extracted or null, never 0; the malformed
   fixture ends `unverifiable`, not `succeeded`; the env-poisoning fixture (credential
   vars planted in the parent env must never reach a subscription-mode child) passes for
   every adapter. Capability honesty is meta-tested,
   omnigent-style: `resume: "native"` requires `resumeArgs` plus a resumed fixture that
   continues the same session; `cost_reporting: "per_run"` requires the success fixture
   to yield non-null cost. A CLI version bump means re-recording fixtures for that
   version dir; a diff in the normalized output IS the drift report.
3. **Live check: `mc harness check <name>`.** Omnigent's parity principle, adapted: never
   mock the boundary we own. Runs the real installed CLI end-to-end on a trivial
   deterministic task ("create file X containing Y") and asserts the full path: launch,
   events, exit, verify, cost extraction, and resume when declared. Costs cents; run
   on demand when writing an adapter or after a CLI update. This is a command, not
   standing infrastructure; scheduled re-verification stays out of scope.

### Supervisor

`mc run` forks a small detached supervisor per run (setsid; stdout/stderr of the harness
captured to files in the run dir). The supervisor:

1. writes the Run row (`queued` then `running`),
2. tails adapter events into the events table,
3. enforces `--budget` (kill + notify on crossing),
4. on child exit: records `exit`, runs the verifier, records `verdict`,
5. fires the `on_terminal` hook exactly once,
6. exits. Its lifetime equals its run's. Nothing global to babysit.

If the supervisor itself dies, the next `mc ls` detects the orphan (pid gone, no terminal
row) and marks the run `lost`, which also fires the hook. `lost` is a first-class outcome,
not a silent absence.

### Verification

Runs before any terminal verdict. v1 verifiers, in order, all cheap and local:

1. **exit code** of the harness process,
2. **git effect** (repo tasks): commits made since launch (HEAD recorded at launch in
   the spec, compared via `rev-list --count`) OR a dirty worktree. An agent that
   commits everything and leaves a clean tree has produced an effect - fleet evidence
   showed the old dirty-tree-only check failing exactly the runs that finished
   cleanest,
3. **artifacts**: every path declared in the spec exists and is non-trivial (>0 bytes,
   basic type sniff),
4. **parser health**: tracks BLINDNESS only - lines mc could not read (`unparsed`) or
   did not recognize (`unknown-native-event`). Harness-REPORTED errors are cleanly
   parsed data and never cap the verdict; blindness caps it at `unverifiable`.

Task specs declare expected artifacts up front; a run with no declared artifacts and no
git effect can at best reach `unverifiable`. Anything flagged visual in the spec
(`--visual`) short-circuits to `needs_human_look`. Vision-based verification (render +
inspect) is explicitly v2.

### Workspace isolation

Every run gets its own directory: a fresh `git worktree add` when the target is a git repo,
a plain `runs/<id>/work` dir otherwise. Never the caller's cwd, never a claw's operating
workspace, never shared between sibling runs (two documented collisions: a bot's child
nearly clobbering its MEMORY.md; sibling forks overwriting each other's mp4).

## Auth & billing

Every run resolves to exactly one of three auth modes at preflight. The default needs
zero config.

**1. `subscription` (default).** The harness CLI's own resident login just works; mc adds
nothing provider-related to the child env, it only *verifies the login exists* on this
host (existence/structure checks only, values never read): claude-code's macOS Keychain
entry ("Claude Code-credentials") or Linux `~/.claude/.credentials.json`; codex's
`~/.codex/auth.json` with a non-null `tokens` field; pi's `~/.pi/agent/auth.json` slot
for the model's provider. Missing login = fail closed: "run `<cli> login` on this host."
Headless hosts use each CLI's own long-lived-token flow (e.g. `claude setup-token` →
`CLAUDE_CODE_OAUTH_TOKEN`), performed once per unix user, on that host.

**2. `api_key` (`--api-key`).** mc reads the adapter's conventional env var
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `MOONSHOT_API_KEY`) from its own resident
environment on this host and forwards exactly that one variable (for kimi-code the
value is delivered to the child as `KIMI_MODEL_API_KEY`, the only env channel that CLI
reads). Not offered for pi: pi has its own `--api-key` flag, but mc refuses to use it
because CLI arguments leak via process listings; pi's own auth.json or `--gateway`
covers every real case.

**3. `gateway` (`--gateway <name>`).** Routes through an OpenAI/Anthropic-compatible
gateway. One builtin entry ships (`openrouter`); more via config:

```toml
[gateway.openrouter]                        # builtin; shown as the shape to copy
base_url_anthropic = "https://openrouter.ai/api"      # claude-code shim wiring
base_url_openai    = "https://openrouter.ai/api/v1"   # codex / pi wiring
env_var            = "OPENROUTER_API_KEY"             # NAME of the resident var; value never stored
wire_api           = "chat"                           # codex only: "chat" | "responses" — which
                                                      # OpenAI wire protocol the gateway speaks.
                                                      # Guessing wrong breaks codex silently
                                                      # (omnigent's documented OpenRouter-vs-LiteLLM
                                                      # symptom); `mc harness check --gateway <name>`
                                                      # asserts the configured value actually works.
```

Gateway mode requires a provider-prefixed model id (`x-ai/grok-4.6`); refused otherwise.
Per-adapter wiring is the documented recipe for each CLI: claude-code gets
`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL` +
`ANTHROPIC_SMALL_FAST_MODEL` + `CLAUDE_CODE_SUBAGENT_MODEL` (and never
`ANTHROPIC_API_KEY`); codex gets `-c model_providers.<name>.*` overrides plus a **fresh
empty per-run `CODEX_HOME`** so a cached ChatGPT auth.json can never collide with the
explicit provider key (codex's key-vs-oauth precedence is documented-buggy); kimi-code
gets `KIMI_MODEL_PROVIDER_TYPE=openai` + `KIMI_MODEL_BASE_URL` + `KIMI_MODEL_NAME` +
`KIMI_MODEL_API_KEY` plus a fresh per-run `KIMI_CODE_HOME` (the gateway's own env var
name is never forwarded - kimi would ignore it); pi gets `--provider` plus exactly the
gateway's env var and nothing else (pi reads ambient env unconditionally, so the
allowlist must stay this narrow).

**Env construction (all modes):** the child env is built additively from an EMPTY object —
`{PATH, HOME, LANG, TERM}` plus the exact mode-specific keys above. There is no
inheritance step, so a stray `ANTHROPIC_API_KEY` in the supervisor's env is structurally
absent from a subscription child rather than "blanked" (this stray-var-silently-wins
failure class hit three separate times in the research: Claude Code's documented
API-key-beats-subscription precedence, codex's auth.json-embedded key, codex's `.env`
auto-loader). The conformance suite includes an env-poisoning fixture: launch each
adapter in subscription mode with credential vars planted in the parent env and assert
the child never sees them.

### Cost semantics

`cost_basis` is a property of (harness, auth_mode), decided at preflight, never inferred
from what the adapter happens to emit:

| harness | auth_mode | cost_basis | cost_usd | --budget |
|---|---|---|---|---|
| claude-code | subscription | flat_subscription | null (flat plan pool, no per-token price) | refused |
| claude-code | api_key | metered_reported | stream-json `total_cost_usd` verbatim | allowed |
| claude-code | gateway | unavailable | null (CLI's figure uses Anthropic's price table on non-Anthropic tokens; kept raw in events, never copied) | refused |
| codex | any | unavailable | null (no cost field in `--json` in any mode; tokens only) | refused |
| kimi-code | any | unavailable | null (stream-json carries no usage or dollar telemetry at all - not even tokens) | refused |
| pi | subscription | metered_reported | pi's `usage.cost.total` (pi's OAuth "extra usage" is genuinely per-token billed — the one subscription that is NOT flat) | allowed |
| pi | gateway | metered_reported | pi's `usage.cost.total` | allowed |

- `--budget` is **refused loudly at preflight** wherever the table can't support it —
  never accepted-but-inert (that would be the silent degradation this spec bans).
- **Implemented:** pi reports per-turn cost deltas, so `--budget` is genuinely enforced
  mid-run for pi (the supervisor kills between turns on overspend - verified by test).
- **v0 note (from code review):** claude-code reports cost only in its terminal result
  event, so even in metered mode a dollar cap could never fire mid-run. `--budget` is
  therefore refused for claude-code entirely in v0 (the table's "allowed" waits for an
  incremental cost signal); `--max-minutes` is the enforceable cap.
- `--max-minutes` is the universal backstop: the supervisor's existing kill-and-notify
  path triggered by wall clock. It's the only cap available for flat-subscription and
  codex runs, and the mitigation for quota-exhausted runs that retry forever.
- **No shadow pricing.** mc never estimates dollars from token counts (that's the
  invented-number anti-pattern already banned for global budgets). `tokens_in/out` are
  the honest signal where dollars don't exist; `cost_basis` lets `mc cost` group
  correctly instead of conflating "$0" with "no dollar concept applies."

### Auth preflight & visibility

All checks run before spawn, fail closed, re-resolved on every run (nothing cached
because "it worked last time"): mode mutual-exclusion, `capabilities.auth_modes`
membership, resident-credential existence, gateway-name and model-shape validation,
budget/cost_basis compatibility. `mc harness ls` gains two columns: declared AUTH MODES
and a live READY/MISSING probe per mode ("subscription: ready (keychain)" / "gateway
openrouter: missing (OPENROUTER_API_KEY unset)"). No new command. `mc harness check`
additionally asserts: the codex scratch-CODEX_HOME path runs non-interactively (no
first-run onboarding hang), and resume/effort behavior per mode. `effort_passthrough`
may only be promoted to `"honored"` for a (adapter version, model) pair that
`mc harness check` has actually demonstrated — never from a naming heuristic.

### Auth security invariants

In addition to the global rules below: (a) the only credential values mc ever reads are
env vars resident on the executing host, forwarded by name into the child env — never
written to spec.json, the db, events, or logs; the run record stores only
`{auth_mode, gateway}`; (b) the supervisor scrubs the literal credential values it
injected from `stdout.jsonl`/`stderr.log`/event payloads before writing (vendor CLIs can
echo auth material on a 401); (c) notification payloads carry `auth_mode` but no
credential-plumbing detail (no env var names, no lookup descriptors).

## Layering

The CLI is a surface, not the product. Structure enforces this:

- **`src/core/`** is the engine: registry, adapters, supervisor, verifier, notifier,
  exported as a typed library API. It never parses argv and never prints.
- **Surfaces are thin bindings over core**: `src/cli.ts` and `src/mcp.ts` in v1. A future
  surface (HTTP API, TUI, desktop app, claw plugin) is another small binding, not a rewrite.
- **The durable contract is data, not code**: the SQLite schema (`runs`, `events`), the
  run-dir layout on disk, and the closed event union. Any tool in any language can
  integrate by reading those (the agentsview pattern: daemon optional, state readable
  straight from SQLite), so replacing or adding a frontend never touches the engine.

## Surfaces

### CLI

```
mc run    --harness H [--model M] [--cwd DIR] [--budget N] [--max-minutes N]
          [--gateway NAME | --api-key] [--artifact PATH]... [--visual] [--effort E] "prompt"
mc run    --spec -            # full RunSpec as JSON on stdin (the remote-safe form)
mc ls     [--json]
mc show   <run-id>            # full record, both axes, verify evidence, cost
mc tail   <run-id>            # follow the event stream
mc kill   <run-id>
mc resume <run-id> [--fresh [--at SHA]] "follow-up"
                              # new linked run inheriting the parent's spec; default =
                              # native session resume, --fresh = checkpoint restart
mc reap                       # cron-safe: mark dead-supervisor runs lost, deliver
                              # pending notifications (push must not depend on `mc ls`)
mc harness ls                 # adapters + capabilities + detection (installed? path? version?)
mc harness check <name>       # live end-to-end check of one adapter against the real CLI
mc cost   [--since 7d]        # per-run and aggregate spend from the ledger
```

There is no SSH code in mc. Remote machines run their own install, and the caller owns
transport. The remote-safe invocation is `ssh box mc run --spec - < task.json` (spec over
stdin, zero quoting surface). No inline remote heredocs, anywhere, ever. A `--host`
convenience wrapper may return later as pure client sugar (see out of scope); nothing in
the engine or schema would change.

### MCP

`mc mcp` (stdio) exposes `run`, `ls`, `show`, `tail`, `kill`, `resume` with the same
semantics, so a live Claude Code session is a first-class orchestrator. Tool descriptions
carry the no-poll contract: "you will be notified on completion; do not poll status."

### Notifications

Per-host config (`~/.mission-control/config.toml`):

```toml
[notify]
exec    = ""                                  # optional: command receiving payload on stdin
webhook = ""                                  # optional: POST target
# example shipped: direct Telegram sendMessage using the box's own bot token
```

Payload is the full Run record (both axes, cost, artifacts, stderr path). One notification
per terminal transition, deduped by run id. Claw integrations are configs, not code.

## Storage layout

```
~/.mission-control/
  config.toml
  mc.db                # runs, events (WAL; single host, single writer discipline)
  runs/<run-id>/
    spec.json          # archived launch spec
    work/              # workdir (or a git worktree pointer)
    stdout.jsonl       # raw native output, untranslated
    stderr.log         # always captured
```

Per-host ledger: each machine that executes runs has its own db. Cross-host views are the
caller's job in v1 (`ssh box mc ls --json`); no sync and no aggregation code (agentsview's
remote-sync pattern is the template if ever needed).

## Security invariants (hard rules)

1. **No credential bridging.** Local secrets never travel to a remote host in env, files,
   specs, or prompts. Remote runs use only credentials already resident on that host; if
   one is missing, the run fails closed at preflight with a clear message. (The old
   runbook's scp-of-local-auth pattern is explicitly banned here.)
2. **Scoped env construction.** Adapters build the child env from an allowlist per harness,
   never by inheriting the supervisor's full environment (the CODEX_HOME leak class).
3. **Workspace containment.** A run cannot be pointed at a claw's own operating directory;
   `mc run` refuses known agent-state paths.
4. **stderr is never /dev/null.** Enforced by construction; there is no code path that
   discards it.

## V1 milestones

1. **Spine**: schema + claude-code adapter + supervisor. `mc run/ls/show/tail/kill` local.
2. **Truth**: verifier + two-axis status + `lost` detection + notify hook with Telegram example.
3. **Reach**: npm install on any host, `--spec -` stdin form, documented ssh invocation
   pattern.
4. **Peers**: codex adapter, then pi adapter; capability table + `mc harness ls/check`;
   the conformance suite with fixtures for all three adapters; `mc resume` (claude-code
   first, codex gated on `mc harness check` passing its resume assertion).
5. **Orchestrator**: `mc mcp` + `mc cost` + per-run `--budget` enforcement.

Each milestone is shippable and used daily before the next starts.

## Explicitly out of scope (v2+ or never)

- Automatic harness/model selection or ranking of competing runs (no evidence of need;
  the operator always names the model).
- Web dashboard (all real status interactions were chat/text; agentsview covers browsing).
- Global/rolling budget policies (numbers would be invented).
- Scheduled capability smoke-testing (standing infrastructure that re-verifies harnesses
  on a timer). The on-demand `mc harness check` command covers the real need; revisit only
  if vendor drift bites twice between manual checks.
- Mid-run stdin steering and a pi-style RPC shim protocol (event union is designed to grow
  into it). Now has two named dependents: live follow-ups into a running session, and
  interactive rows on the `mc top` board. First candidate for v2.
- `mc top`: a live board TUI (needs-me / working / completed groups over the runs table,
  latest-event snippet per row). Read-only version is a thin surface once v1 ships;
  interactive rows (answer a blocked run from the list) depend on steering.
- `--host` client sugar and cross-host aggregation in `mc ls`: plain `ssh box mc ...`
  covers v1; revisit when `mc top` wants a merged multi-host view.
- Cross-silo history search and cost analytics (agentsview's job; we store `session_id`
  to jump into it).
- A resident dispatcher agent (documented failure mode; revisit only with a strong model
  and a concrete trigger-from-phone need).
- Nested runs spawning runs, depth limits, cascade-kill (add when an orchestrating run
  actually needs to spawn children).

## Open questions

- Codex resume: RESOLVED - `codex exec resume <session-id>` verified end-to-end by
  `mc harness check codex` (codex-cli 0.144.6, session continued, artifact appended).
- Pi session_id: RESOLVED - pi sessions live in the run dir via `--session-dir`; the
  session id resumes with `--session <id>`, verified by `mc harness check pi`.
- `lost`-run detection cadence: on-demand at `mc ls` in v1; decide whether milestone 5
  needs a `mc reap` cron on the box.
- macOS Keychain scopes claude-code's subscription login to one OS user identity: two
  different human operators sharing one unix account on a host is outside the model
  (per-host ledger already assumes one operator per account; make that explicit if it
  ever changes).
- Mid-run OAuth token-refresh failure on a headless box (revoked refresh token, blocked
  egress): currently lands as a generic `failed` with error events; decide whether it
  deserves its own classification once observed in practice.
- Parallel subscription runs share one quota pool with the operator's interactive use;
  daemon-less mc has no queueing mechanism. `--max-minutes` bounds the damage; revisit
  per-auth-mode concurrency only if quota contention actually bites.
- Command-based credential sources (run a command to fetch a key, for rotation) deferred:
  it's an arbitrary-code-execution surface hanging off config; static resident env vars
  cover v1.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { ADAPTERS, getAdapter } from "./core/adapters/registry.ts";
import { resolveAuth } from "./core/auth.ts";
import { loadConfig } from "./core/config.ts";
import { eventsAfter, findRun, listRuns, markLost, getRun, insertEvent } from "./core/db.ts";
import { launch } from "./core/launch.ts";
import { notifyTerminal } from "./core/notify.ts";
import { PreflightError, type Run, type RunSpec } from "./core/types.ts";

function fail(message: string): never {
  console.error(`mc: ${message}`);
  process.exit(1);
}

function requireRun(idOrPrefix: string | undefined): Run {
  if (!idOrPrefix) fail("run id required");
  const run = findRun(idOrPrefix);
  if (!run) fail(`no run matches "${idOrPrefix}"`);
  return run;
}

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signal the harness's whole process GROUP (it's spawned `detached: true` by
 * the supervisor, making it a group leader) so descendants die too, not just
 * the recorded pid. Falls back to signalling the bare pid if the group is
 * already gone or unavailable (e.g. a pid whose group predates this fix, or
 * a process that was never a group leader). Returns which path landed -
 * callers escalating a SIGTERM need to know, because the two paths require
 * different liveness checks afterward (see killWithEscalation).
 */
function killGroupOrPid(pid: number, signal: NodeJS.Signals): "group" | "bare" {
  try {
    process.kill(-pid, signal);
    return "group";
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
    return "bare";
  }
}

/**
 * Whether the harness's process GROUP still has any member alive - checked
 * via signal 0 against the negative pid, which throws ESRCH only once every
 * process in the group is gone. Deliberately broader than checking the
 * leader pid alone: if the harness exits on SIGTERM but a descendant it
 * spawned ignores it, the leader pid disappears (a plain `pidAlive` check
 * would read "dead" and skip SIGKILL) while the group - and a
 * pipe-holding descendant that can block the supervisor's close event -
 * survives. Escalation must track the group, not the leader.
 */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `mc kill` is a short-lived CLI invocation, not a resident watcher, so the
 * SIGTERM-then-SIGKILL escalation happens inline here rather than being
 * scheduled and left to outlive the process: send SIGTERM, poll liveness for
 * up to `timeoutMs`, then SIGKILL if it's still standing.
 *
 * WHICH liveness check to poll depends on which path the SIGTERM actually
 * took. The normal case (detached:true group leader) sends a real group
 * signal, so the GROUP is what has to disappear - poll `groupAlive`. But
 * when `killGroupOrPid` had to fall back to a bare-pid signal (no such
 * process group exists - e.g. a run launched before the detached:true fix,
 * or a pid that was never a group leader), `process.kill(-pid, 0)` throws
 * ESRCH immediately regardless of whether the process itself is still
 * alive: polling `groupAlive` there would read "dead" on the very first
 * check and skip SIGKILL entirely for a process that's actively ignoring
 * SIGTERM. Track the path from the initial signal and poll - and escalate
 * SIGKILL via - the matching check in both branches.
 */
async function killWithEscalation(pid: number, timeoutMs = 10_000): Promise<void> {
  const path = killGroupOrPid(pid, "SIGTERM");
  const alive = () => (path === "group" ? groupAlive(pid) : pidAlive(pid));
  const start = Date.now();
  while (alive() && Date.now() - start < timeoutMs) {
    await sleep(250);
  }
  if (alive()) killGroupOrPid(pid, "SIGKILL");
}

/** Live process start time - see supervisor.ts's matching `pidStart` for why `ps -o lstart=`. */
function pidStart(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const out = result.stdout.trim();
  return out || null;
}

/**
 * The harness pid's start time as the supervisor recorded it at spawn (the
 * `pid_start` field on its initial `status_change` event - see
 * supervisor.ts). Scans rather than indexes: this is a once-per-kill,
 * bounded-size read, consistent with how `show`/`tail` already walk a run's
 * event stream.
 */
function recordedPidStart(runId: string, pid: number): string | null {
  for (const event of eventsAfter(runId, 0)) {
    if (event.kind !== "status_change") continue;
    const payload = event.payload as { pid?: number; pid_start?: string | null };
    if (payload.pid === pid && typeof payload.pid_start === "string") return payload.pid_start;
  }
  return null;
}

/**
 * Authoritative identity check before signalling a run whose supervisor is
 * NOT confirmably alive (a `lost` row, including one just reaped from
 * `running` - see the `kill` handler). A pid can be reused - by an
 * unrelated process, or by a DIFFERENT concurrent run of the SAME harness
 * binary, which a command-line match cannot tell apart. Process start time
 * is per-instance and authoritative: it's assigned once, at fork, and
 * nothing short of the same process can produce it again. Fails SAFE - a
 * missing recorded value, a vanished live process, or any mismatch all
 * refuse rather than risk signalling the wrong process.
 */
function looksLikeOwnedProcess(run: Run): boolean {
  if (!run.pid) return false;
  const recorded = recordedPidStart(run.id, run.pid);
  if (!recorded) return false;
  return pidStart(run.pid) === recorded;
}

const QUEUED_GRACE_MS = 15_000;

function isActive(run: Run): boolean {
  return run.exit === "running" || run.exit === "queued";
}

/**
 * Detect watcher death and missed pushes. A running OR queued row whose
 * SUPERVISOR is gone is lost - even if the harness process itself is still
 * alive, nobody is logging, capping, verifying, or notifying it anymore.
 * The lost transition is atomic (markLost) so a supervisor finishing between
 * our snapshot and the write can never have its terminal truth clobbered.
 * This detection always runs, for every caller.
 *
 * `deliver` gates a SEPARATE concern: whether a terminal-but-unnotified row
 * also gets a (re)dispatch attempt here. Read commands (`ls`/`show`/`tail`,
 * and `harness check`'s poll) must pass false and stay side-effect free -
 * they only report the current truth, undelivered or not. Only `mc reap`
 * (the cron-safe delivery path SPEC designates) passes true; the supervisor
 * delivers too, but via its own direct notifyTerminal call at terminal, not
 * through this function.
 *
 * Why read commands can't deliver: fix 2 (retry on full delivery failure)
 * leaves `notified` false so a permanently-failing hook gets retried by a
 * later `mc reap`. If a read command dispatched too, `mc tail` - which polls
 * every 500ms and only breaks once a terminal row produces no NEW events -
 * would see notifyTerminal's own fresh notify_result event as "new" on every
 * poll and never break, hammering the failing hook forever.
 *
 * `deliver` defaults to false: a caller that doesn't explicitly opt into
 * delivery must not deliver, since false is the safe choice (it never
 * spuriously fires a hook). Every delivering call site (`mc reap`, `mc
 * harness check`'s poll) passes `true` explicitly; any caller that omits the
 * argument - including ones added later without knowing about this flag -
 * correctly falls back to the non-delivering, side-effect-free read path.
 */
async function reapLostRuns(runs: Run[], deliver = false): Promise<Run[]> {
  const config = deliver ? loadConfig() : null;
  const out: Run[] = [];
  for (const run of runs) {
    let current = run;
    if (isActive(current)) {
      const watcherPid = current.supervisor_pid ?? current.pid;
      // Freshly-launched rows have no watcher pid recorded yet; give them grace.
      const young =
        current.exit === "queued" &&
        watcherPid == null &&
        Date.now() - new Date(current.started_at).getTime() < QUEUED_GRACE_MS;
      if (!young && !pidAlive(watcherPid)) {
        if (markLost(current.id)) {
          const orphanedHarness = current.pid != null && pidAlive(current.pid);
          insertEvent(current.id, "exited", {
            exit: "lost",
            note: orphanedHarness
              ? `supervisor died; harness pid ${current.pid} may still be running unwatched`
              : "watcher died without a terminal row",
          });
        }
        current = getRun(current.id)!;
      }
    }
    if (deliver && !isActive(current) && !current.notified) {
      await notifyTerminal(current, config!);
      current = getRun(current.id) ?? current;
    }
    out.push(current);
  }
  return out;
}

function age(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

// Wall-clock span of the run itself (started_at -> ended_at), distinct from
// age() which measures time since start and keeps counting for runs still
// going. A run with no ended_at yet (still running/queued) has no duration
// to report - "-" rather than a misleading in-progress number that would
// look like a final total.
function duration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "-";
  const seconds = Math.max(0, (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000);
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

// Compact token count for table display: 73000 -> "73k", 950 -> "950".
function compactTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

function tokensCell(r: Pick<Run, "tokens_in" | "tokens_out">): string {
  if (r.tokens_in == null && r.tokens_out == null) return "-";
  return `${compactTokens(r.tokens_in ?? 0)}/${compactTokens(r.tokens_out ?? 0)}`;
}

interface ParsedRunArgs {
  spec: RunSpec;
}

function parseRunArgs(args: string[]): ParsedRunArgs {
  let harness: string | null = null;
  let model: string | null = null;
  let cwd: string | null = null;
  let budget: number | null = null;
  let maxMinutes: number | null = null;
  let maxIdleMinutes: number | null = null;
  let gateway: string | null = null;
  let apiKey = false;
  let visual = false;
  const artifacts: string[] = [];
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = () => {
      const value = args[++i];
      if (value === undefined) fail(`${arg} requires a value`);
      return value;
    };
    const nextPositive = () => {
      const value = Number(next());
      if (!Number.isFinite(value) || value <= 0) fail(`${arg} must be a finite positive number`);
      return value;
    };
    const nextNonNegative = () => {
      const value = Number(next());
      if (!Number.isFinite(value) || value < 0) fail(`${arg} must be a finite number >= 0 (0 disables)`);
      return value;
    };
    switch (arg) {
      case "--harness": harness = next(); break;
      case "--model": model = next(); break;
      case "--cwd": cwd = next(); break;
      case "--budget": budget = nextPositive(); break;
      case "--max-minutes": maxMinutes = nextPositive(); break;
      case "--max-idle-minutes": maxIdleMinutes = nextNonNegative(); break;
      case "--gateway": gateway = next(); break;
      case "--api-key": apiKey = true; break;
      case "--visual": visual = true; break;
      case "--artifact": artifacts.push(next()); break;
      case "--effort":
        fail("--effort is not supported in v0 (no harness passthrough is verified; see SPEC.md)");
        break;
      default:
        if (arg.startsWith("--")) fail(`unknown flag ${arg}`);
        positional.push(arg);
    }
  }

  if (!harness) fail("--harness is required");
  if (gateway && apiKey) fail("--gateway and --api-key are mutually exclusive");
  const prompt = positional.join(" ").trim();
  if (!prompt) fail("a prompt is required");

  return {
    spec: {
      harness,
      model,
      prompt,
      cwd,
      artifacts,
      visual,
      budget_usd: budget,
      max_minutes: maxMinutes,
      max_idle_minutes: maxIdleMinutes,
      auth: gateway ? { mode: "gateway", gateway } : apiKey ? { mode: "api_key" } : { mode: "subscription" },
    },
  };
}

async function readSpecFromStdin(): Promise<RunSpec> {
  const raw = await text(process.stdin);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`--spec -: stdin is not valid JSON`);
  }
  // Same fail-closed validation as the flag form - this is the remote-safe
  // surface, where a malformed payload is the most likely failure mode.
  if (typeof parsed?.harness !== "string" || !parsed.harness) fail(`--spec -: "harness" (string) is required`);
  if (typeof parsed?.prompt !== "string" || !parsed.prompt.trim()) fail(`--spec -: "prompt" (string) is required`);
  return {
    harness: parsed.harness,
    model: parsed.model ?? null,
    prompt: parsed.prompt,
    cwd: parsed.cwd ?? null,
    artifacts: parsed.artifacts ?? [],
    visual: parsed.visual ?? false,
    budget_usd: parsed.budget_usd ?? null,
    max_minutes: parsed.max_minutes ?? null,
    max_idle_minutes: parsed.max_idle_minutes ?? null,
    auth: parsed.auth ?? { mode: "subscription" },
  };
}

/**
 * mc harness check: never mock the boundary we own. Runs the REAL installed CLI
 * end to end on a trivial deterministic task and asserts the full path - launch,
 * events, session_id, exit, verify, cost extraction, and native resume when
 * declared. Costs cents by design; run when writing an adapter or after a CLI
 * update. The runs it creates are ordinary ledger rows (visible in mc ls).
 */
async function harnessCheck(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) fail("usage: mc harness check <name> [--gateway NAME] [--model M]");
  let gateway: string | null = null;
  let model: string | null = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--gateway") gateway = args[++i] ?? fail("--gateway requires a value");
    else if (args[i] === "--model") model = args[++i] ?? fail("--model requires a value");
    else fail(`unknown flag ${args[i]}`);
  }
  const adapter = getAdapter(name);
  const failures: string[] = [];
  const report = (label: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
    if (!ok) failures.push(label);
  };

  const waitTerminal = async (id: string, timeoutMs: number): Promise<Run> => {
    const start = Date.now();
    for (;;) {
      // Not one of the general read commands: this polls a run `mc harness
      // check` itself just launched, and breaks the instant it goes
      // terminal (no "wait for a quiet poll" condition), so it can't loop
      // hammering a hook the way `mc tail` could. Delivering here is
      // harmless either way - the atomic claim (fix 3) means it can only
      // ever race the supervisor's own dispatch, never double-fire.
      const current = (await reapLostRuns([getRun(id)!], true))[0]!;
      if (!isActive(current)) return current;
      if (Date.now() - start > timeoutMs) fail(`check run ${id} did not terminate within ${timeoutMs / 60000} minutes`);
      await sleep(1000);
    }
  };

  console.log(`checking ${name}${gateway ? ` via gateway ${gateway}` : ""} (this runs the real CLI and costs real usage)`);
  const marker = `mc harness check ${Math.random().toString(36).slice(2, 8)}`;
  const spec: RunSpec = {
    harness: name,
    model,
    prompt: `Create a file mc-check.txt containing exactly this one line: ${marker}`,
    cwd: null,
    artifacts: ["mc-check.txt"],
    visual: false,
    budget_usd: null,
    max_minutes: 10,
    max_idle_minutes: 10,
    auth: gateway ? { mode: "gateway", gateway } : { mode: "subscription" },
  };
  const run = launch(spec);
  console.log(`  run ${run.id} launched...`);
  const done = await waitTerminal(run.id, 10 * 60_000);

  report("exit=succeeded", done.exit === "succeeded", `got ${done.exit}`);
  report("verdict=verified", done.verdict === "verified", `got ${done.verdict}`);
  report("session_id captured", done.session_id != null, done.session_id ?? "missing");
  const content = existsSync(join(done.workdir, "mc-check.txt"))
    ? readFileSync(join(done.workdir, "mc-check.txt"), "utf8")
    : "";
  report("artifact content exact", content.trim() === marker, content.trim().slice(0, 60));
  if (adapter.capabilities.tokens_reporting === "reported") {
    report("tokens extracted", done.tokens_out != null && done.tokens_out > 0, `out=${done.tokens_out}`);
  }
  if (adapter.capabilities.cost_reporting === "per_run" && done.cost_basis === "metered_reported") {
    report("cost extracted (declared per_run + metered)", done.cost_usd != null, `$${done.cost_usd}`);
  }

  if (adapter.capabilities.resume === "native" && done.session_id) {
    const resumed = launch(
      {
        ...spec,
        prompt: `Append exactly this one line to mc-check.txt: resumed OK`,
        artifacts: ["mc-check.txt"],
      },
      { parent: done },
    );
    console.log(`  resume run ${resumed.id} launched...`);
    const resumedDone = await waitTerminal(resumed.id, 10 * 60_000);
    report("resume exit=succeeded", resumedDone.exit === "succeeded", `got ${resumedDone.exit}`);
    const after = existsSync(join(done.workdir, "mc-check.txt"))
      ? readFileSync(join(done.workdir, "mc-check.txt"), "utf8")
      : "";
    report("resume continued in same workdir", after.includes("resumed OK") && after.includes(marker), after.trim().slice(0, 80));
    report("resume captured a session_id", resumedDone.session_id != null, resumedDone.session_id ?? "missing");
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed for ${name}`);
    process.exit(1);
  }
  console.log(`\nall checks passed for ${name}`);
}

function printHelp(): void {
  const version = createRequire(import.meta.url)("../package.json").version as string;
  const harnesses = ADAPTERS.map((a) => a.name).join(", ");
  const gateways = Object.keys(loadConfig().gateways).join(", ");
  console.log(`mission-control v${version} - control plane for delegated agent runs

USAGE
  mc <command> [options]

COMMANDS
  run           Launch a tracked, isolated, verified run on a harness
  resume <id>   Continue a run with a follow-up prompt: a new linked run that
                inherits harness/model/auth/artifacts/visual/caps. Default:
                native session resume in the SAME workdir. With --fresh
                [--at SHA]: checkpoint restart - NEW worktree at the commit,
                NEW session (for escaping stuck or degraded sessions).
                Overrides: --artifact (replaces inherited list), --visual,
                --no-visual, --max-minutes, --max-idle-minutes, --budget
  reap          Cron-safe: mark dead-supervisor runs lost, deliver pending
                notifications (e.g. */10 * * * * mc reap)
  ls            List runs; also reaps lost runs and re-delivers missed notifications
  show <id>     Full run record, verification evidence, recent events
  tail <id>     Follow a run's event stream until it terminates
  kill <id>     Request termination (state lands when the process actually dies)
  harness ls    Adapters: capabilities, install status, live auth probes
  harness check <name> [--gateway G] [--model M]
                Live end-to-end validation against the REAL CLI (costs cents):
                launch, verify, session_id, cost/token extraction, native resume
  help          This page (also: -h, --help anywhere)

RUN OPTIONS
  --harness H       Required. Registered: ${harnesses}
  --model M         Model id; gateway mode needs a provider prefix (moonshotai/kimi-k3)
  --cwd DIR         Git repo to work on; isolated via git worktree (non-git refused)
  --artifact PATH   Declared deliverable, workdir-relative; the verifier checks it
                    exists and is non-empty (repeatable)
  --visual          Output needs human eyes; verdict terminates at needs_human_look
  --max-minutes N   Wall-clock cap: kill + notify when exceeded
  --max-idle-minutes N
                    Stall cap: kill when the harness emits nothing on
                    stdout/stderr for N minutes (default 30; 0 disables)
  --budget N        Dollar cap; refused where no enforceable cost signal exists
  --gateway NAME    Route via an LLM gateway. Known: ${gateways}
  --api-key         Use the conventional API-key env var instead of the resident login
  --spec -          Read a full RunSpec as JSON from stdin (the remote-safe form:
                    ssh box mc run --spec - < task.json)

AUTH (per run; default = subscription)
  subscription   The harness CLI's own resident login on THIS host; mc adds nothing
  api_key        Forwards exactly one env var resident on this host (ANTHROPIC_API_KEY)
  gateway        OpenRouter-compatible routing; key env var must be resident here
  Credentials never cross machines; missing ones fail closed at preflight.

STATUS (two axes, never conflated)
  exit      queued | running | succeeded | failed | killed | lost
  verdict   pending | verified | failed_verification | unverifiable | needs_human_look
  DONE means succeeded AND verified: declared checks passed, confirmed mechanically,
  never taken from the agent's own claims.

FILES & ENV
  ~/.mission-control/       state root (override: MC_HOME)
    mc.db                   runs + events (SQLite; any tool can read it)
    runs/<id>/              spec.json, work/, stdout.jsonl, stderr.log
    config.toml             [notify] exec/webhook hooks; [gateway.NAME] blocks
  MC_CLAUDE_BIN             override the claude binary path (pinning/testing)
  MC_DETECT_TIMEOUT_MS      wall-clock budget for each harness's --version
                            probe (default 10000; raise it if detect()/
                            harness ls falsely reports a slow-but-working
                            CLI as not installed)

EXAMPLES
  mc run --harness claude-code --artifact out/report.md "write the report"
  mc run --harness claude-code --gateway openrouter --model moonshotai/kimi-k3 \\
        --max-minutes 30 --artifact hello.txt "build hello.txt"
  mc ls --json | jq '.[0].verdict'
  mc harness ls`);
}

export async function cliMain(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  const [command, ...args] = argv;

  try {
    switch (command) {
      case "run": {
        const spec = args[0] === "--spec" && args[1] === "-" ? await readSpecFromStdin() : parseRunArgs(args).spec;
        const run = launch(spec);
        console.log(`${run.id}  ${run.title}`);
        console.log(`    harness=${run.harness} model=${run.model ?? "(default)"} auth=${run.auth_mode} cost_basis=${run.cost_basis}`);
        console.log(`    workdir=${run.workdir}`);
        console.log(`    mc tail ${run.id}   # follow`);
        break;
      }

      case "ls": {
        // Read command: detect lost runs, but never dispatch/retry delivery
        // (that's `mc reap`'s job) - see reapLostRuns's doc comment.
        const runs = await reapLostRuns(listRuns(), false);
        if (args.includes("--json")) {
          console.log(JSON.stringify(runs, null, 2));
          break;
        }
        if (runs.length === 0) {
          console.log("no runs");
          break;
        }
        const header = ["ID", "TITLE", "HARNESS", "MODEL", "EXIT", "VERDICT", "COST", "TOKENS", "DURATION", "AGE"];
        const rows = runs.map((r) => [
          r.id,
          r.title.slice(0, 40),
          r.harness,
          (r.model ?? "").slice(0, 24),
          r.exit,
          r.verdict,
          r.cost_usd != null ? `$${r.cost_usd.toFixed(2)}` : r.cost_basis === "flat_subscription" ? "plan" : "-",
          tokensCell(r),
          duration(r.started_at, r.ended_at),
          age(r.started_at),
        ]);
        const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
        for (const row of [header, ...rows]) {
          console.log(row.map((cell, i) => cell.padEnd(widths[i]!)).join("  "));
        }
        break;
      }

      case "show": {
        // Read command: detect lost runs only, never dispatch/retry delivery.
        const run = (await reapLostRuns([requireRun(args[0])], false))[0]!;
        console.log(JSON.stringify(run, null, 2));
        // Highlighted summary: the JSON above already carries cost_usd/tokens_in/
        // tokens_out/started_at/ended_at, but as ~4 fields among ~20 - and on a
        // long run the final cost_update can scroll out of the 10-event window
        // below. One line keeps "what did this cost" glanceable without a second
        // source of truth (still computed from the same run row, nothing new).
        const cost = run.cost_usd != null ? `$${run.cost_usd.toFixed(2)}` : run.cost_basis === "flat_subscription" ? "plan" : "unavailable";
        console.log(`\ncost=${cost}  tokens=${tokensCell(run)}  duration=${duration(run.started_at, run.ended_at)}`);
        const recent = eventsAfter(run.id, 0).slice(-10);
        if (recent.length > 0) {
          console.log("\nlast events:");
          for (const event of recent) console.log(`  [${event.seq}] ${event.kind} ${JSON.stringify(event.payload).slice(0, 120)}`);
        }
        break;
      }

      case "tail": {
        const run = requireRun(args[0]);
        let seq = 0;
        for (;;) {
          for (const event of eventsAfter(run.id, seq)) {
            seq = event.seq;
            console.log(`${event.ts} ${event.kind} ${JSON.stringify(event.payload)}`);
          }
          // Reap here too - otherwise a dead supervisor leaves tail polling a
          // frozen `running` row forever. Never dispatch/retry delivery from
          // here though: notifyTerminal's own notify_result event would
          // count as "new" below on every poll, so a permanently-failing
          // hook would keep this loop from ever seeing a quiet poll and it
          // would never break, hammering the hook forever. `mc reap` is the
          // retry path; this is a read command.
          const current = (await reapLostRuns([getRun(run.id)!], false))[0]!;
          if (!["running", "queued"].includes(current.exit) && eventsAfter(run.id, seq).length === 0) {
            console.log(`-- terminal: exit=${current.exit} verdict=${current.verdict} --`);
            break;
          }
          await sleep(500);
        }
        break;
      }

      case "kill": {
        const requested = requireRun(args[0]);
        // Reap first: a `running` row whose supervisor has already died is
        // exactly the case the ownership check below exists for (nobody's
        // confirmed this pid still belongs to this run), and reaping is
        // what turns it into `lost` - so the same check path covers both a
        // stale `running` row and a genuinely long-lost one.
        const run = (await reapLostRuns([requested]))[0]!;
        // Gate on the harness pid actually being alive, not on exit==="running":
        // a `lost` run (dead supervisor, live harness) is exactly the case
        // nobody else can signal, so it must stay killable through mc.
        const alive = pidAlive(run.pid);
        if (run.exit !== "running" && !(run.exit === "lost" && alive)) {
          fail(`run ${run.id} is not killable (exit=${run.exit}${run.pid ? `, harness pid ${run.pid} ${alive ? "alive" : "already dead"}` : ", no pid recorded"})`);
        }
        // A `lost` row can persist indefinitely before anyone runs `mc kill`
        // on it, so its recorded pid may since have been reused - by an
        // unrelated process, or by a different concurrent run of the same
        // harness. Refuse rather than risk signalling the wrong process.
        if (run.exit === "lost" && run.pid && !looksLikeOwnedProcess(run)) {
          fail(`pid ${run.pid} is not run ${run.id}'s harness (start time mismatch, PID reuse); refusing`);
        }
        // Durable intent BEFORE signalling: even if the harness traps SIGTERM
        // and exits 0, or the escalation below has to wait out the full
        // timeout, this event is already on the ledger so a killed run is
        // never mislabeled succeeded.
        insertEvent(run.id, "status_change", { kill_requested: true, by: "mc kill" });
        if (run.pid) {
          await killWithEscalation(run.pid);
        }
        console.log(`kill requested for ${run.id} (mc tail ${run.id} to watch it land)`);
        break;
      }

      case "resume": {
        const parent = requireRun(args[0]);
        // A continuation inherits everything verification-relevant from the
        // parent's archived spec - harness/model/auth AND artifacts/visual/
        // caps - unless explicitly overridden. Silently dropping the parent's
        // declared checks was how continuation runs lost their verifiability
        // (fleet evidence: every artifact-less resume capped below verified).
        const parentStored = JSON.parse(readFileSync(parent.spec_path, "utf8"));
        let maxMinutes: number | null | undefined;
        let maxIdleMinutes: number | null | undefined;
        let budget: number | null | undefined;
        let visual: boolean | undefined;
        let fresh = false;
        let at: string | undefined;
        const artifacts: string[] = [];
        const positional: string[] = [];
        for (let i = 1; i < args.length; i++) {
          const arg = args[i]!;
          const next = () => {
            const value = args[++i];
            if (value === undefined) fail(`${arg} requires a value`);
            return value;
          };
          const nextPositive = () => {
            const value = Number(next());
            if (!Number.isFinite(value) || value <= 0) fail(`${arg} must be a finite positive number`);
            return value;
          };
          const nextNonNegative = () => {
            const value = Number(next());
            if (!Number.isFinite(value) || value < 0) fail(`${arg} must be a finite number >= 0 (0 disables)`);
            return value;
          };
          switch (arg) {
            case "--artifact": artifacts.push(next()); break;
            case "--max-minutes": maxMinutes = nextPositive(); break;
            case "--max-idle-minutes": maxIdleMinutes = nextNonNegative(); break;
            case "--budget": budget = nextPositive(); break;
            case "--visual": visual = true; break;
            case "--no-visual": visual = false; break;
            case "--fresh": fresh = true; break;
            case "--at": at = next(); break;
            default:
              if (arg.startsWith("--")) fail(`unknown flag ${arg} (resume inherits spec fields from the parent)`);
              positional.push(arg);
          }
        }
        if (at && !fresh) fail("--at requires --fresh (a native resume continues the session where it is)");
        const prompt = positional.join(" ").trim();
        if (!prompt) fail("a follow-up prompt is required");
        const run = launch(
          {
            harness: parent.harness,
            model: parent.model,
            prompt,
            cwd: null,
            artifacts: artifacts.length > 0 ? artifacts : (parentStored.artifacts ?? []),
            visual: visual ?? Boolean(parentStored.visual),
            budget_usd: budget !== undefined ? budget : (parentStored.budget_usd ?? null),
            max_minutes: maxMinutes !== undefined ? maxMinutes : (parentStored.max_minutes ?? null),
            max_idle_minutes: maxIdleMinutes !== undefined ? maxIdleMinutes : (parentStored.max_idle_minutes ?? null),
            auth: parentStored.auth ?? { mode: "subscription" },
          },
          { parent, fresh, at },
        );
        console.log(`${run.id}  ${run.title}`);
        if (fresh) {
          console.log(`    fresh restart of ${parent.id} from checkpoint${at ? ` ${at}` : " (parent HEAD)"} in ${run.workdir}`);
        } else {
          console.log(`    resumes ${parent.id} (session ${parent.session_id}) in ${run.workdir}`);
        }
        console.log(`    mc tail ${run.id}   # follow`);
        break;
      }

      case "reap": {
        // Cron-safe lost-run detection + at-least-once notification delivery:
        // the push half of the system must not depend on anyone running `mc
        // ls`/`show`/`tail` - those read commands deliberately do NOT
        // dispatch or retry delivery (see reapLostRuns's doc comment). This
        // is the one place besides the supervisor's own terminal dispatch
        // that does.
        const before = listRuns();
        const activeIds = new Set(before.filter(isActive).map((r) => r.id));
        const unnotified = new Set(before.filter((r) => !isActive(r) && !r.notified).map((r) => r.id));
        const after = await reapLostRuns(before, true);
        const lost = after.filter((r) => r.exit === "lost" && activeIds.has(r.id)).length;
        // "settled": the delivery obligation was discharged - a channel
        // delivered, or none were configured. Not a claim of guaranteed
        // external receipt (a failed hook leaves notified=false for retry).
        const settled = after.filter((r) => r.notified && (unnotified.has(r.id) || (activeIds.has(r.id) && r.exit === "lost"))).length;
        console.log(`reaped ${lost} lost run(s), settled ${settled} notification(s)`);
        break;
      }

      case "harness": {
        if (args[0] === "check") {
          await harnessCheck(args.slice(1));
          break;
        }
        if (args[0] !== "ls") fail("usage: mc harness ls | mc harness check <name> [--gateway NAME] [--model M]");
        const config = loadConfig();
        for (const adapter of ADAPTERS) {
          const detection = adapter.detect();
          console.log(`${adapter.name}`);
          console.log(`  installed: ${detection.installed ? `yes (${detection.path}, ${detection.version ?? "?"})` : "no"}`);
          console.log(`  capabilities: ${JSON.stringify(adapter.capabilities)}`);
          for (const mode of adapter.capabilities.auth_modes) {
            let probe: string;
            try {
              const spec: RunSpec = {
                // kimi-code requires a model in every mode; give the probe one so
                // it reports credential readiness, not the model requirement.
                harness: adapter.name, model: mode === "gateway" || adapter.name === "kimi-code" ? "probe/probe" : null, prompt: "probe",
                cwd: null, artifacts: [], visual: false, budget_usd: null, max_minutes: null, max_idle_minutes: null,
                auth: mode === "gateway" ? { mode, gateway: "openrouter" } : { mode },
              };
              const resolved = resolveAuth(spec, adapter, config);
              probe = `ready (${resolved.source})`;
            } catch (error) {
              probe = error instanceof PreflightError ? `missing (${error.message.split(";")[0]})` : "error";
            }
            console.log(`  auth ${mode}: ${probe}`);
          }
        }
        break;
      }

      case "help":
      case undefined:
        printHelp();
        break;

      default:
        fail(`unknown command "${command}" (try: mc help)`);
    }
  } catch (error) {
    if (error instanceof PreflightError) fail(error.message);
    throw error;
  }
}

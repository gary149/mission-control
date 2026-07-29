# Operating mission-control as an agent

You are an orchestrator: you launch runs, mc supervises and verifies them, you act on
what actually happened. This is the distilled practice from real fleet operation -
every rule below exists because its absence burned a real orchestrator.

## The two axes, never conflated

`exit` is what the process did (succeeded/failed/killed/lost). `verdict` is whether the
declared checks passed, confirmed mechanically (verified/failed_verification/
unverifiable/needs_human_look). Done means **succeeded AND verified**. A run's own
"I finished successfully!" text is a claim, not a result; mc exists because such claims
are unreliable. Never report delegated work as done on exit alone.

`needs_human_look` is terminal for subjective work (`--visual`): do not loop relaunching
trying to turn it into `verified` - it will never happen. Hand it to the human.

## Launching

- **Declare every deliverable**: `--artifact path` (repeatable). Verification only
  bites on declared outputs; a run that builds the right thing undeclared can at best
  verdict `unverifiable`, and you lose the mechanical proof you wanted.
- **One mission per run.** Bundled missions produce one blended verdict you cannot act
  on. Split them; lineage will keep them related.
- **Caps are not optional.** `--max-minutes` for wall clock, `--max-idle-minutes` for
  stalls (default 30). `--budget` (USD) only where cost is genuinely metered
  (`opencode`, `pi` today - mc refuses it elsewhere rather than pretend).
- **Remote launches**: `ssh box mc run --spec - < task.json`. Arguments leak via
  process listings; specs on stdin do not.

## Reading results

- Machine-read the ledger: `mc ls --json` is the clean JSON interface, and the SQLite
  db (below) is always there. `mc show <id>` is for inspection - a JSON record followed
  by human-formatted summary lines - so do not pipe it to a JSON parser. Never parse
  the human table either; it is for humans and it will change.
- **Read `verify_evidence` check by check before discarding a run.** A `killed` run
  whose artifact checks all pass is salvage, not garbage: the work exists in its
  workdir right now. If the record has a `session_id`, `mc resume <id>` continues in
  that same workdir. If it does not (a mid-run kill can land before some harnesses
  yield their session reference), the outputs are still on disk in `runs/<id>/work` -
  integrate them directly, or restart from the last committed checkpoint with
  `mc resume <id> --fresh --at <sha>`, which needs no session. Restarting from scratch
  pays the whole cost again to rebuild what you already have.
- **Triage `error` events before any retry.** The payload tells you whether retrying
  can even help. An auth/quota failure (e.g. `403 Key limit exceeded`) fails every
  future run identically: stop launching, alert the operator, back off. Retrying into
  a wall burns your schedule and fills the ledger with noise.

## Continuing work

- `mc resume <id> "follow-up"` - same session, same workdir, inherited caps/artifacts.
- `mc resume <id> --fresh --at <sha> "mission"` - checkpoint restart: new worktree at
  the commit, new session. This is the escape hatch for stuck or degraded sessions.
- **Do not hand-roll continuation state.** Prose state machines and side JSON files
  drift from reality; mc's lineage (`parent_run_id`, `root_run_id`) is already the
  durable record of what continued from what. Query it instead of maintaining a copy.

## Being woken instead of polling

- Configure push once: `[notify] exec` or `webhook` in `~/.mission-control/config.toml`
  delivers one JSON payload per terminal transition. Point it at your own wake
  endpoint and stop spending scheduler ticks asking "done yet?".
- Cron `mc reap` (e.g. every 10 minutes). It marks dead-supervisor runs `lost` and
  re-delivers their notifications - without it, a crashed supervisor is a run that
  terminates silently.
- **In-process timers are not durable.** If you run under a harness yourself
  (`claude -p` and friends), your process ends at end of turn and scheduled wakeups
  die with it. Continuation must be driven from outside: the notify hook fires your
  watchdog, the watchdog decides to resume.

## Hygiene

- Each run works in `~/.mission-control/runs/<id>/work`, an isolated git worktree.
  After you have integrated a run's commits (merged/pushed), its worktree is dead
  weight - prune terminal, integrated worktrees or your fleet eventually fills the
  disk mid-mission.
- The ledger is SQLite at `~/.mission-control/mc.db` (`runs`, `events`); any tool in
  any language can read it directly. That is the supported interface for building
  dashboards, watchdogs, and reports - not scraping CLI output.

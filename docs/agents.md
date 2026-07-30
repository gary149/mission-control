# Operating mission-control as an agent

You are an orchestrator: you launch runs, mc supervises and verifies them, you act on
what actually happened. This is the distilled practice from real fleet operation -
every rule below exists because its absence burned a real orchestrator.

## Exit is a process fact, not the agent's word for it

`exit` (`queued`/`running`/`succeeded`/`failed`/`killed`/`lost`) is derived from what
the process actually did - its real exit code, a kill signal, a kill request - never
from the agent's own claim of success. A run's own "I finished successfully!" text is
a claim, not a result: some harnesses (pi, confirmed) exit the process with code 0 even
when the final turn itself reported an error, and mc classifies that `failed` anyway.
`exit` says nothing about the *quality* of the output, though - whether the deliverable
is actually right is a judgment you or the operator still have to make by looking, the
same way you would for any other delegated work. "Recording assessments" below is
where that judgment goes once you've made it - `mc assess`, not a second thing mc
computes for you.

## Launching

- **Declare every deliverable**: `--artifact path` (repeatable). It is injected into
  the prompt as where to write the output - a hint the harness reads, not a check mc
  runs after the fact. Confirming the output is genuinely correct is on you.
- **One mission per run.** A bundled multi-part mission produces one `exit` you cannot
  attribute to a specific part of it. Split them; lineage will keep them related.
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
- Filter on state directly instead of post-filtering JSON: `mc ls --exit running`,
  `mc ls --exit failed,killed,lost` (composes with `--json`).
- **Look at the actual output before discarding a run, `killed` included.** A `killed`
  run's workdir still holds whatever the harness had written up to that point - real
  progress, not garbage. If the record has a `session_id`, `mc resume <id>` continues
  in that same workdir. If it does not (a mid-run kill can land before some harnesses
  yield their session reference), the outputs are still on disk in `runs/<id>/work` -
  integrate them directly, or restart from the last committed checkpoint with
  `mc resume <id> --fresh --at <sha>`, which needs no session. Restarting from scratch
  pays the whole cost again to rebuild what you already have.
- **Triage `error` events before any retry.** The payload tells you whether retrying
  can even help. An auth/quota failure (e.g. `403 Key limit exceeded`) fails every
  future run identically: stop launching, alert the operator, back off. Retrying into
  a wall burns your schedule and fills the ledger with noise.

## Recording assessments

`exit` told you the process didn't crash. It never told you the work is right. If
you're the one looking at the actual output - reading the diff, running the tests,
opening the artifact - record what you conclude:

- **Assess AFTER inspecting, not instead of it.** `mc assess <id> --by <you>
  --disposition accepted|retry|blocked` is only worth anything if you looked first.
  mc will happily accept a rubber-stamped `accepted` with no evidence at all - it
  validates the assessment's shape, never your judgment - which means the honesty of
  the record is entirely on you. Attribution gives provenance, not trust; don't spend
  that trust carelessly.
- **Attribute honestly.** `--by` is your name or identity, not a shared bot account.
  If you are an Orchestrator recording this on the operator's behalf, say so instead
  of borrowing their name. mc separately records what it observed running the command
  (`observed`, os user@host) - it doesn't need you to fake the `reviewer` field to
  look legitimate.
- **`retry` and `blocked` are more actionable than `accepted`.** A rubber-stamped
  `accepted` on broken work is a dead end nobody investigates. `retry` (worth another
  attempt - `mc resume` it) and `blocked` (needs a human, or a dependency, before
  anything else can happen) tell the next reader, or the next automation, exactly
  what to do. Reach for them whenever "accepted" would be generous.
- **Pass `--evidence` and `--at` when you have them.** `--evidence path...` hashes
  (sha256) whatever file backed up your call - test output, a rendered screenshot, a
  build log. `--at SHA` pins the checkpoint you actually reviewed, verified against
  the run's own workdir when it still exists. Neither is required, but an unattributed
  `accepted` with zero evidence is a weaker record than one that says what was checked.
- **A correction is a new assessment, never an edit.** Got it wrong the first time?
  `mc assess` the run again with the corrected disposition. The earlier one stays on
  the record - `mc show <id>` prints the full history, oldest first - and the LATEST
  one is what `mc ls`/`mc ls --review` and any consuming automation act on.

Consuming assessments (yours or another reviewer's) works the same way in reverse:

- **Gate advancement on `accepted`, never on `exit`.** `exit: "succeeded"` is a
  process fact an unattended harness can produce on its own; `accepted` is a
  specific person or agent's recorded say-so that the result is good. Automation that
  merges, deploys, or hands off downstream work should key off the assessment's
  disposition (`[notify.assessment]`, gated on `disposition == "accepted"`), not off
  the run's exit code. See `docs/integrations/merge-queue.md` for the canonical
  example: **mc observes clean exits; a reviewer claims acceptance; only acceptance
  authorizes advancement.**
- **`mc ls --review pending` is your review queue.** Every terminal run nobody has
  assessed yet, without guessing from `exit` alone. `mc ls --review retry,blocked`
  surfaces exactly what still needs work.

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

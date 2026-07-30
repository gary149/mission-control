# Merge-queue landing integration (config, not code)

Wires mc's push seam to a local merge queue (e.g.
a merge-queue tool) so a
run's own worktree lands itself - rebase, run the project's real check command, push
through a FIFO queue - the moment a reviewer records `accepted` on it. No orchestrator
required: this is one shell script and one config line, and it works identically
whether the assessment comes from a human at a terminal running `mc assess`, or an
orchestrating agent that inspected the output and is attributing its own judgment. mc's
own obligations don't change - reliable terminal push, honest run record, an
attributed and append-only assessment ledger - the queue is a peer tool connected by
config, same as the Telegram/hermes examples in this directory.

Requires the merge-queue tool already `init`-ed against the target repo (its own docs
cover that one-time setup: numbered worktree lanes, the pre-push hook, the
`checkCommand`). This doc only covers the mc side: turning an `accepted` assessment
into a `land` invocation.

## The principle

**mc observes clean exits; a reviewer claims acceptance; only acceptance authorizes
advancement.** A run's `exit: "succeeded"` is a process fact - the harness didn't crash,
error, or get killed. It has never been a claim about whether the work is any good, and
gating an automated merge on it alone means the merge queue is trusting the harness's
own say-so. Wiring the queue to `mc assess`'s `accepted` disposition means a real
reviewer (human or an orchestrating agent that actually looked at the diff) is the one
who decided the work is mergeable - and that decision, and who made it, is on the
record, forever, in the `assessments` table.

## Primary recipe: gate on assessment (recommended)

### [notify.assessment] hook

`~/.mission-control/assess-land.sh`:

```sh
#!/usr/bin/env bash
# mc assessment-recorded -> merge-queue land. Payload arrives on stdin as
# {topic, run, assessment} - see SPEC.md's Assessments section.
set -euo pipefail
payload="$(cat)"

read -r disposition workdir <<<"$(printf '%s' "$payload" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d["assessment"]["disposition"], d["run"]["workdir"])
')"

# Only "accepted" authorizes advancement - mc validates the assessment's
# STRUCTURE (see db.ts / SPEC.md), never the judgment itself, so this gate is
# the one place a human or reviewing agent's actual say-so decides whether
# automation proceeds. "retry"/"blocked" are exactly as actionable as
# "accepted" - they just mean stop here, not merge.
[ "$disposition" = "accepted" ] || exit 0

# land runs FROM the run's own worktree and does its own gating (rebase onto
# the integration branch, run the configured checkCommand, push through the
# tool's FIFO queue only if that passes) - this hook's only job is to trigger
# it at the right worktree, at the right moment, once a reviewer has signed off.
cd "$workdir" && merge-queue land
```

`~/.mission-control/config.toml`:

```toml
[notify.assessment]
exec = "/home/USER/.mission-control/assess-land.sh"
```

Note this is a **separate** config section from `[notify]` - assessment payloads are
shaped differently (`{topic, run, assessment}`, not a bare run record) and dispatch
through their own seam precisely so they can never misfire an integration built
against the terminal-run shape. See SPEC.md's Assessments section and
`docs/agents.md`.

### Recording the assessment

Whoever reviews the run's output - a human at a terminal, or an orchestrating agent
that inspected the diff - runs:

```sh
mc assess <run-id> --by alice --disposition accepted --evidence dist/build.log
```

before this hook ever fires. There is no automatic path to `accepted`: mc never
assesses a run itself (see SPEC.md's never-judges principle), so a `land` never
happens without a specific, attributed, recorded decision that it should.

### Reap cron

Both the run-terminal push and the assessment-recorded push need this - landing must
not depend on anyone running `mc ls`:

```
*/10 * * * * /usr/local/bin/mc reap >> /tmp/mc-reap.log 2>&1
```

`mc reap` retries undelivered notifications of BOTH kinds (run and assessment) from
their own `notified` flags.

## Weaker alternative: gate on exit (process fact only)

Wiring `[notify]` (the terminal-run hook) to `land` on `exit == "succeeded"` still
works and is simpler to set up - no separate `mc assess` step required - but it is
**strictly weaker**: it lands the moment the harness exits cleanly, before any human or
agent has looked at what it actually produced. Use this only where the project's
`checkCommand` is trusted to be a complete substitute for review (rare), or as a
stepping stone before wiring up assessments.

```sh
#!/usr/bin/env bash
# mc terminal-transition -> merge-queue land. Payload arrives on stdin.
set -euo pipefail
payload="$(cat)"

read -r exit_ workdir <<<"$(printf '%s' "$payload" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d["exit"], d["workdir"])
')"

# `succeeded` is a PROCESS fact (clean exit), not a quality judgment - mc does
# not verify work. Gating on it here only selects which runs ENTER the landing
# path; the merge queue's checkCommand is the sole actual gate, so make that
# command a real build+test, not a placeholder. killed/lost runs may still
# hold salvageable work in their workdir - they are excluded from AUTOMATIC
# landing, not from manual integration. A run still `queued`/`running` never
# reaches this hook (it only fires on terminal transitions).
[ "$exit_" = "succeeded" ] || exit 0

cd "$workdir" && merge-queue land
```

```toml
[notify]
exec = "/home/USER/.mission-control/notify-land.sh"
```

## Notes

- **`land`'s gate is only as good as the project's `checkCommand`.** Point it at a
  real build+test script, not a placeholder - the tool cannot itself distinguish a
  real check from `echo ok`, and neither can this hook.
- **A failed `land` is not silently swallowed**: the hook's `set -euo pipefail` means
  a non-zero exit from `merge-queue land` (rebase conflict, failed check) propagates
  as the notify hook's own failure, which mc's `notify_result` (for the exit-based
  variant) or the assessment row's `notified` flag (for the primary recipe) records
  as undelivered - `mc reap` retries it. Worth pairing with your own alerting on
  repeated notify failures for the same run, since a permanently-conflicting
  worktree will retry forever otherwise.
- **`promote` (integration branch -> production) is deliberately left out of this
  integration.** The merge-queue tool keeps that step human-only by its own design;
  this integration only ever automates *landing* into the integration branch, never
  the final ship.
- **Multiple concurrent runs against the same repo are exactly what the queue is
  for.** Each accepted run's `land` call rebases onto whatever already landed and
  re-runs the check - the FIFO serialization is what removes the need for an
  orchestrator to hand-coordinate which worktree integrates first.
- **A `retry`/`blocked` assessment is not a dead end.** It is the reviewer's most
  actionable signal: fix it (via `mc resume`) and re-assess, rather than treating a
  non-accepted run as a failure to discard.

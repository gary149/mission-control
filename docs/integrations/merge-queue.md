# Merge-queue landing integration (config, not code)

Wires mc's push seam to a local merge queue (e.g.
[claude-code-merge-queue](https://github.com/funador/claude-code-merge-queue)) so a
run's own worktree lands itself - rebase, run the project's real check command, push
through a FIFO queue - the moment mc reports it `succeeded`. No orchestrator required:
this is one shell script and one config line, and it works identically whether it's
triggered by a human's `mc run` from a laptop, or by hermes/OpenClaw/any other stack's
wake endpoint reading the same payload afterward. mc's own obligations don't change -
reliable terminal push, honest run record - the queue is a peer tool connected by
config, same as the Telegram/hermes examples in this directory.

Requires the merge-queue tool already `init`-ed against the target repo (its own docs
cover that one-time setup: numbered worktree lanes, the pre-push hook, the
`checkCommand`). This doc only covers the mc side: turning a terminal push into a
`land` invocation.

## Notify hook

`~/.mission-control/notify-land.sh`:

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

# Only a run that actually succeeded is a landing candidate - failed/killed/lost
# runs have nothing worth rebasing in, and a run still `queued`/`running` never
# reaches this hook (it only fires on terminal transitions).
[ "$exit_" = "succeeded" ] || exit 0

# land runs FROM the run's own worktree and does its own gating (rebase onto
# the integration branch, run the configured checkCommand, push through the
# tool's FIFO queue only if that passes) - this hook's only job is to trigger
# it at the right worktree, at the right moment, unattended.
cd "$workdir" && merge-queue land
```

`~/.mission-control/config.toml`:

```toml
[notify]
exec = "/home/USER/.mission-control/notify-land.sh"
```

## Reap cron

Landing must not depend on anyone running `mc ls`:

```
*/10 * * * * /usr/local/bin/mc reap >> /tmp/mc-reap.log 2>&1
```

## Notes

- **`land`'s gate is only as good as the project's `checkCommand`.** Point it at a
  real build+test script, not a placeholder - the tool cannot itself distinguish a
  real check from `echo ok`, and neither can this hook.
- **A failed `land` is not silently swallowed**: the hook's `set -euo pipefail` means
  a non-zero exit from `merge-queue land` (rebase conflict, failed check) propagates
  as the notify hook's own failure, which mc's `notify_result` records as
  undelivered - `mc reap` retries it. Worth pairing with your own alerting on
  repeated notify failures for the same run, since a permanently-conflicting
  worktree will retry forever otherwise.
- **`promote` (integration branch -> production) is deliberately left out of this
  hook.** The merge-queue tool keeps that step human-only by its own design; this
  integration only ever automates *landing* into the integration branch, never the
  final ship.
- **Multiple concurrent runs against the same repo are exactly what the queue is
  for.** Each finished run's `land` call rebases onto whatever already landed and
  re-runs the check - the FIFO serialization is what removes the need for an
  orchestrator to hand-coordinate which worktree integrates first.

# Hermes integration (config, not code)

Hermes already reads mc's ledger (seam 2: `mc show`, sqlite) from its own
scheduler. The missing piece on the box is the push seam, which replaces
hourly polling with immediate wakeups - and makes continuity watchdogs
event-driven instead of timer-driven.

## Notify hook

`~/.mission-control/notify-hermes.sh` - adapt the endpoint/auth to the
hermes gateway's wake/event route (token read from hermes's own config at
delivery time, never stored in mc's config):

```sh
#!/usr/bin/env bash
# mc terminal-transition -> hermes gateway. Payload arrives on stdin.
set -euo pipefail
payload="$(cat)"
# Example shape; point at the hermes gateway's local event/wake endpoint:
curl -fsS -X POST http://127.0.0.1:PORT/hooks/wake \
  -H "Authorization: Bearer $(cat /home/hermes/.hermes/auth-token)" \
  -H 'Content-Type: application/json' \
  -d "{\"text\": \"mc run terminal: $(printf '%s' "$payload" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(f"{d[\"id\"]} exit={d[\"exit\"]} verdict={d[\"verdict\"]}")')\"}"
```

`~/.mission-control/config.toml` (as the hermes user):

```toml
[notify]
exec = "/home/hermes/.mission-control/notify-hermes.sh"
```

## Reap cron

```
*/10 * * * * /home/hermes/.local/bin/mc reap >> /tmp/mc-reap.log 2>&1
```

## Replacing the hand-rolled checkpoint pattern

The `supervised-coding-agent-runs` skill's recovery recipe (checkpoint commit
-> raw `git worktree add --detach` -> fresh `mc run`) is now a tracked
primitive:

```sh
mc resume <stuck-run-id> --fresh --at <checkpoint-sha> "fresh finalization mission..."
```

Same lineage (`parent_run_id`), a new isolated worktree at the checkpoint, a
new session, and the parent's declared artifacts/visual/caps inherited - no
untracked git operations, no guardrail to route around.

## One harness trap worth keeping in the skill

In-session wakeup timers are NOT durable under `claude -p`: the process ends
at end_turn and scheduled wakeups die with it. Continuation must be driven
from outside - the notify hook above firing your watchdog, which decides to
`mc resume`. (Root cause of the round-six silent stall.)

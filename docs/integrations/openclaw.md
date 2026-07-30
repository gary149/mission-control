# OpenClaw integration (config, not code)

mc pushes one JSON payload per terminal run transition; OpenClaw ingests
arbitrary events through its wake webhook. Wiring them together is two files
on the box - mc never learns what OpenClaw is.

## Notify hook

`~/.mission-control/notify-openclaw.sh` (the hook token is read from
OpenClaw's own config at delivery time - never stored in mc's config):

```sh
#!/usr/bin/env bash
# mc terminal-transition -> OpenClaw wake. Payload arrives on stdin.
set -euo pipefail
payload="$(cat)"
token="$(python3 -c 'import json; print(json.load(open("/root/.openclaw/openclaw.json"))["hooks"]["token"])')"
text="mc run terminal: $(printf '%s' "$payload" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(f"{d[\"id\"]} exit={d[\"exit\"]} - {d[\"title\"]}")')"
curl -fsS -X POST http://127.0.0.1:18789/hooks/wake \
  -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1], "mode": "now"}))' "$text")"
```

`~/.mission-control/config.toml`:

```toml
[notify]
exec = "/root/.mission-control/notify-openclaw.sh"
```

## Reap cron

Push delivery must not depend on anyone running `mc ls`:

```
*/10 * * * * /usr/bin/mc reap >> /tmp/mc-reap.log 2>&1
```

## Agent-side guidance worth adding to the bot's skills

- Launch delegated coding work through `mc run` (declared `--artifact`s,
  `--max-minutes`) instead of raw `codex exec`/`claude -p` dispatch.
- Before diagnosing a failed run, read `mc show <id>` (the record, recent
  events) and the `stderr_path` file. Never guess.
- Continue work with `mc resume <id>` (same session) or
  `mc resume <id> --fresh` (checkpoint restart) - never a duplicate `mc run`.
- Report `exit`: what the process actually did, not what the agent claimed.
  It says nothing about output quality - look at the actual result before
  calling delegated work done.

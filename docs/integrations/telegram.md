# Telegram integration (config, not code)

mc pushes one JSON payload per terminal run transition; this script turns that
payload into a Telegram message plus the run's declared artifacts, so a run posts
its own result to chat without an orchestrator having to build that last mile.
Requires `curl` and `python3` (both already assumed by the other integration docs);
no other dependency.

## Notify hook

`~/.mission-control/notify-telegram.sh` (the bot token and chat id are read from
their own env vars at delivery time - never stored in mc's config):

```sh
#!/usr/bin/env bash
# mc terminal-transition -> Telegram message + artifacts. Payload arrives on stdin.
set -euo pipefail
: "${TELEGRAM_BOT_TOKEN:?set to the bot's token}"
: "${TELEGRAM_CHAT_ID:?set to the destination chat id}"
payload="$(cat)"
api="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

read -r id title exit_ verdict workdir <<<"$(printf '%s' "$payload" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d["id"], json.dumps(d["title"]), d["exit"], d["verdict"], d["workdir"])
')"

text="mc ${id} exit=${exit_} verdict=${verdict} - ${title}"
curl -fsS -X POST "$api/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${text}" >/dev/null

# Best-effort: post each declared artifact that still exists (relative to the
# run's own workdir - a run that never produced its artifact just sends the
# text above, which already carries the verdict that says so).
printf '%s' "$payload" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for a in d.get("artifacts", []):
    print(a)
' | while IFS= read -r artifact; do
  path="${workdir}/${artifact}"
  [ -f "$path" ] || continue
  curl -fsS -X POST "$api/sendDocument" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    -F "document=@${path}" >/dev/null
done
```

`~/.mission-control/config.toml`:

```toml
[notify]
exec = "/home/USER/.mission-control/notify-telegram.sh"
```

`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` must be resident wherever the hook actually
runs (the supervisor's environment, or exported in the hook itself right after the
`set -euo pipefail` line) - never bridged in from another machine.

## Reap cron

Push delivery must not depend on anyone running `mc ls`:

```
*/10 * * * * /usr/local/bin/mc reap >> /tmp/mc-reap.log 2>&1
```

## Notes

- This posts every declared artifact unconditionally; for a run with many or large
  artifacts, filter `artifacts` in the python snippet above (by extension, by name)
  before wiring it to something with real chat traffic.
- A run with no declared `--artifact`s still gets the text message - `verdict` alone
  (`needs_human_look`, `unverifiable`, ...) is often the useful part for visual or
  exploratory work.

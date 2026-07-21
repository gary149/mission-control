# mission-control

Control plane for delegated agent runs. `mc` launches a coding-agent harness on a task,
watches it to termination with a detached per-run supervisor, mechanically verifies the
declared outputs, and pushes you the truth.

See [SPEC.md](./SPEC.md) for the full design, [CONTEXT.md](./CONTEXT.md) for the domain
glossary, and [docs/adr/](./docs/adr/) for the decisions.

## v0

Requires [Bun](https://bun.sh). One harness adapter (claude-code), all three auth modes.

```sh
bun src/mc.ts help

# Subscription (default; uses the CLI's own resident login):
bun src/mc.ts run --harness claude-code --artifact out/report.md "write the report"

# Any model via OpenRouter (key must be resident on this host):
bun src/mc.ts run --harness claude-code --gateway openrouter \
  --model moonshotai/kimi-k3 --max-minutes 30 --artifact hello.txt "..."

bun src/mc.ts ls            # what ran, both status axes, cost, age
bun src/mc.ts tail <id>     # follow the normalized event stream
bun src/mc.ts show <id>     # full run record + verification evidence
bun src/mc.ts kill <id>
bun src/mc.ts harness ls    # adapters, capabilities, live auth probes
```

State lives in `~/.mission-control/` (override with `MC_HOME`): `mc.db` (runs + events),
`runs/<id>/` (spec.json, isolated workdir, stdout.jsonl, stderr.log). Notifications:
add `[notify] exec/webhook` to `~/.mission-control/config.toml` - one push per terminal
transition with both status axes.

Tests run against a stub harness (no API cost): `bun test`.

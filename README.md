# mission-control

Control plane for delegated agent runs. `mc` launches a coding-agent harness on a task,
watches it to termination with a detached per-run supervisor, mechanically verifies the
declared outputs, and pushes you the truth.

See [SPEC.md](./SPEC.md) for the full design, [CONTEXT.md](./CONTEXT.md) for the domain
glossary, and [docs/adr/](./docs/adr/) for the decisions.

## Install

Building requires [Bun](https://bun.sh); the installed `mc` is a single self-contained
binary with no runtime dependency.

```sh
git clone https://github.com/gary149/mission-control && cd mission-control
./install.sh                      # -> ~/.local/bin/mc
# PREFIX=/usr/local/bin ./install.sh   for a system-wide install
```

For a Linux host (e.g. your remote box): run the same `./install.sh` on it, or
cross-compile from anywhere with `bun run build:linux` and copy `dist/mc-linux-x64` over.

For development, `bun link` exposes the source entrypoint as `mc`, or use
`bun src/mc.ts ...` directly.

## Use

v0 ships one harness adapter (claude-code) with all three auth modes.

```sh
mc help

# Subscription (default; uses the CLI's own resident login):
mc run --harness claude-code --artifact out/report.md "write the report"

# Any model via OpenRouter (key must be resident on this host):
mc run --harness claude-code --gateway openrouter \
  --model moonshotai/kimi-k3 --max-minutes 30 --artifact hello.txt "..."

mc ls            # what ran, both status axes, cost, age
mc tail <id>     # follow the normalized event stream
mc show <id>     # full run record + verification evidence
mc kill <id>
mc harness ls    # adapters, capabilities, live auth probes
```

State lives in `~/.mission-control/` (override with `MC_HOME`): `mc.db` (runs + events),
`runs/<id>/` (spec.json, isolated workdir, stdout.jsonl, stderr.log). Notifications:
add `[notify] exec/webhook` to `~/.mission-control/config.toml` - one push per terminal
transition with both status axes.

Tests run against a stub harness (no API cost): `bun test`.

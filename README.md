# mission-control

Control plane for delegated agent runs. `mc` launches a coding-agent harness on a task,
watches it to termination with a detached per-run supervisor, mechanically verifies the
declared outputs, and pushes you the truth.

See [SPEC.md](./SPEC.md) for the full design, [CONTEXT.md](./CONTEXT.md) for the domain
glossary, and [docs/adr/](./docs/adr/) for the decisions.

## Install

`mc` is a single self-contained binary with no runtime dependency. Every push to main
rebuilds the rolling [`latest` release](../../releases/latest) (darwin-arm64, linux-x64,
linux-arm64) via GitHub Actions.

```sh
git clone https://github.com/gary149/mission-control && cd mission-control
./install.sh --from-release       # download prebuilt (needs gh auth; repo is private)
# or build from source (needs bun):
./install.sh
# PREFIX=/usr/local/bin ./install.sh   for a system-wide install
```

No-clone install on any authed machine (e.g. the remote box):

```sh
gh release download latest -R gary149/mission-control -p "mc-linux-x64" -O ~/.local/bin/mc
chmod +x ~/.local/bin/mc
```

macOS note: downloaded binaries must be ad-hoc signed or arm64 kills them at launch;
`install.sh` does this automatically (`codesign --remove-signature` + `--force --sign -`).

For development, `bun link` exposes the source entrypoint as `mc`, or use
`bun src/mc.ts ...` directly.

## Use

Three harness adapters - claude-code, codex, pi - each verified end-to-end against the
real CLI by `mc harness check` (launch, verify, session capture, native resume).

```sh
mc help

# Subscription (default; uses the CLI's own resident login):
mc run --harness claude-code --artifact out/report.md "write the report"

# Any model via OpenRouter (key must be resident on this host):
mc run --harness claude-code --gateway openrouter \
  --model moonshotai/kimi-k3 --max-minutes 30 --artifact hello.txt "..."

mc resume <id> "also add tests"   # continue the session, new linked run, same workdir
mc harness check codex            # live validation against the real CLI (costs cents)

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

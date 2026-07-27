# mission-control

Control plane for delegated agent runs. `mc` launches a coding-agent harness on a task,
watches it to termination with a detached per-run supervisor, mechanically verifies the
declared outputs, and pushes you the truth.

See [SPEC.md](./SPEC.md) for the full design, [CONTEXT.md](./CONTEXT.md) for the domain
glossary, and [docs/adr/](./docs/adr/) for the decisions.

## Install

`mc` is an npm package on Node.js >= 22.13 with zero runtime dependencies
(SQLite via `node:sqlite`, no native modules). The compiled `dist/` is
committed, so installs run no scripts at all - nothing builds, nothing can
race or fail at install time. See
[ADR 0002](./docs/adr/0002-node-runtime-and-npm-distribution.md) for why the
compiled-binary distribution was retired.

```sh
npm install -g https://github.com/gary149/mission-control/archive/refs/heads/main.tar.gz
```

(The tarball URL is deliberate: `npm install -g` with a `github:` git spec
silently installs a truncated package - an npm bug on both npm 10 and 11 that
drops most of the shipped files. The archive URL uses npm's tarball fetcher,
which is correct.)

or from a clone:

```sh
git clone https://github.com/gary149/mission-control && cd mission-control
npm link       # puts `mc` on PATH
```

Remote machines are the same commands (install Node once per host; no
toolchain beyond npm, no signing, nothing to download by hand).

Development: `node src/mc.ts ...` runs the TypeScript source directly
(Node >= 22.18 strips types natively); `npm run build` refreshes `dist/`,
and CI fails any change where the committed `dist/` is stale.

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
                                  # (inherits the parent's artifacts/visual/caps)
mc resume <id> --fresh --at <sha> "start over from the checkpoint"
                                  # checkpoint restart: NEW worktree at the commit,
                                  # NEW session - for escaping stuck sessions
mc reap                           # cron-safe lost-run sweep + pending notifications
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

Tests run against a stub harness (no API cost): `npm test`.

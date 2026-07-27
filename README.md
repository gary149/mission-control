# mission-control

![mission-control](docs/hero.jpg)

**Fire a coding agent at a task. Walk away. Get pinged with a verified result.**

`mc` launches an agent CLI headlessly, supervises it to completion, mechanically checks
the outputs it promised, and reports two independent truths per run: `exit` (did the
process finish cleanly) and `verdict` (did the work actually check out).

## Install

**Ask your agent** (Hermes, OpenClaw, Claude Code - anything with a shell). Paste this
prompt and it installs itself:

```text
Install mission-control on this machine:
npm install -g https://github.com/gary149/mission-control/archive/refs/heads/main.tar.gz
```

**Or by hand:**

```sh
npm install -g https://github.com/gary149/mission-control/archive/refs/heads/main.tar.gz
```

Node >= 22.13, zero dependencies, nothing compiles. Same one-liner on every machine you
delegate to.

## First run

```sh
mc run --harness claude-code --max-minutes 30 --artifact index.html \
  "build a playable browser FPS in a single index.html: pointer-lock aim, WASD, targets that fall when shot"

mc ls            # exit + verdict + cost, at a glance
mc tail <id>     # live event stream - tool calls, subagents spinning up, cost ticking
mc show <id>     # full record + verification evidence
```

Yes, really - hand it a half-hour build and close the laptop. Each run executes in an
isolated workdir, and `verified` means mc mechanically checked the declared artifact
exists with real content - not that the agent claimed success.

## Harnesses

| | harness | wraps | works with | live `--budget` |
|:-:|---|---|---|:-:|
| <img src="docs/icons/claude.svg" width="18"> | `claude-code` | Claude Code | Claude login &middot; `ANTHROPIC_API_KEY` &middot; OpenRouter | |
| <img src="docs/icons/codex.svg" width="18"> | `codex` | OpenAI Codex | ChatGPT login &middot; `OPENAI_API_KEY` &middot; OpenRouter | |
| <img src="docs/icons/kimi.svg" width="18"> | `kimi-code` | Kimi Code | `MOONSHOT_API_KEY` &middot; OpenRouter | |
| <img src="docs/icons/opencode.svg" width="18"> | `opencode` | opencode | `opencode auth login` &middot; OpenRouter | ✓ |
| <img src="docs/icons/pi.svg" width="18"> | `pi` | pi | pi login &middot; OpenRouter | ✓ |

```sh
mc harness ls              # what's installed here + which auth is ready
mc harness check opencode  # prove an adapter end-to-end against the real CLI
```

Every adapter is grounded in a live probe of the real CLI and validated end-to-end:
launch, event parsing, session capture, native resume.

## Any model, any harness

The default auth is each CLI's own resident login. With an `OPENROUTER_API_KEY` on the
host, any OpenRouter model runs through any harness:

```sh
mc run --harness opencode --gateway openrouter --model moonshotai/kimi-k3 \
  --budget 2 --artifact app.py "build the thing"   # --budget 2 = hard cap at $2 of spend
```

Where the harness reports real metered cost (`opencode`, `pi`), `--budget` (USD) kills
the run mid-flight the moment accumulated spend crosses the cap. Everywhere else use
`--max-minutes`.

## Follow-ups

```sh
mc resume <id> "also add tests"        # continue the same session, same workdir
mc resume <id> --fresh --at <sha> "…"  # restart clean from a git checkpoint,
                                       # for escaping stuck sessions
```

## Notifications

One push per finished run, carrying both `exit` and `verdict`:

```toml
# ~/.mission-control/config.toml
[notify]
exec = "my-notify-script"                 # receives the run record as JSON on stdin
# or
webhook = "https://example.com/hook"      # POSTed the same JSON
```

`mc reap` (cron it) sweeps runs whose supervisor died and delivers their pending
notifications - nothing terminates silently.

## Going deeper

- [SPEC.md](./SPEC.md) - full design: adapters, verification, auth, cost model
- [CONTEXT.md](./CONTEXT.md) - domain glossary
- [docs/adr/](./docs/adr/) - decisions and their reasons

State lives in `~/.mission-control/` (`MC_HOME` to relocate). `npm test` runs the full
e2e suite against stub CLIs - no API cost. Development: `node src/mc.ts …` runs
straight from source; `npm run build` refreshes the committed `dist/`.

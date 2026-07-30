# Mission Control

![Mission Control](docs/hero.jpg)

**You pick the harness, the model, and the task. Your orchestrator fires it off, gets
pinged with the result, and just keeps moving.**

`mc` launches an agent CLI headlessly, supervises it to completion, and reports `exit`:
what the process actually did (`succeeded`, `failed`, `killed`, `lost`) - not what the
agent claimed.

## Install

**Ask your agent** (Hermes, OpenClaw, Claude Code - anything with a shell). Paste this
prompt and it installs itself:

```text
Install mission-control on this machine:
npm install -g https://github.com/gary149/mission-control/archive/refs/heads/main.tar.gz
```

**Or directly:**

```sh
npm install -g https://github.com/gary149/mission-control/archive/refs/heads/main.tar.gz
```

Node >= 22.13, zero dependencies, nothing compiles. Same one-liner on every machine you
delegate to.

## Harnesses

| | harness | wraps | works with | live `--budget` |
|:-:|---|---|---|:-:|
| <img src="docs/icons/claude.svg" width="18"> | `claude-code` | Claude Code | Claude login &middot; `ANTHROPIC_API_KEY` &middot; OpenRouter | |
| <img src="docs/icons/codex.svg" width="18"> | `codex` | OpenAI Codex | ChatGPT login &middot; `OPENAI_API_KEY` &middot; OpenRouter | |
| <img src="docs/icons/kimi.svg" width="18"> | `kimi-code` | Kimi Code | `MOONSHOT_API_KEY` &middot; OpenRouter | |
| <img src="docs/icons/opencode.svg" width="18"> | `opencode` | opencode | `opencode auth login` &middot; OpenRouter | ✓ |
| <img src="docs/icons/pi.svg" width="18"> | `pi` | pi | pi login &middot; OpenRouter | ✓ |

Every adapter is grounded in a live probe of the real CLI and validated end-to-end:
launch, event parsing, session capture, native resume.

## First run

**Ask your agent:**

```text
Use mission control to build a playable browser FPS on claude code with kimi-k3 via openrouter, ping me when done.
```

**Or directly:**

```sh
# no --model needed: uses your Claude login and its default model
mc run --harness claude-code --max-minutes 360 --artifact index.html \
  "build a playable browser FPS in a single index.html: pointer-lock aim, WASD, targets that fall when shot"
```

Yes, really - give it the afternoon and close the laptop. Each run executes in its own
git worktree (collision isolation between runs, not an OS sandbox - the agent runs
full-auto), and `exit` reports what the process actually did - not what the agent
claimed.

## Commands

```sh
mc run --harness H [--model M] [--gateway openrouter] [--budget 99] \
       [--max-minutes 360] [--max-idle-minutes 30] [--artifact PATH] "task"
mc ls                        # every run: exit + cost + tokens + duration
mc ls --exit running         # filter by state (comma-separated: --exit failed,killed,lost)
mc tail <id>                 # live event stream - tool calls, subagents, cost ticking
mc show <id>                 # full record + recent events
mc resume <id> "add tests"   # continue the session, new linked run, same workdir
mc resume <id> --fresh --at <sha> "…"   # restart clean from a git checkpoint
mc kill <id>
mc reap                      # cron-safe sweep: lost runs + pending notifications
mc harness ls                # adapters, capabilities, which auth is ready here
mc harness check opencode --gateway openrouter --model moonshotai/kimi-k3
                             # prove an adapter end-to-end against the real CLI
mc help                      # every command and flag
```

## Any model, any harness

The default auth is each CLI's own resident login. With an `OPENROUTER_API_KEY` on the
host, any OpenRouter model runs through any harness:

```sh
mc run --harness opencode --gateway openrouter --model moonshotai/kimi-k3 \
  --budget 99 --artifact app.py "build the thing"   # kill when spend crosses $99
```

Where the harness reports real metered cost (`opencode`, `pi`), `--budget` (USD) kills
the run the moment accumulated spend crosses the cap (checked between turns, so it can
overshoot by one turn). Everywhere else use `--max-minutes`. Either way, a run whose
harness goes silent past `--max-idle-minutes` (default 30) is killed as a stall.

OpenRouter is just the builtin. Any OpenAI- or Anthropic-compatible endpoint (LiteLLM,
vLLM, a corporate proxy) is one config block away:

```toml
# ~/.mission-control/config.toml
[gateway.myproxy]
base_url_openai = "https://llm.example.com/v1"   # and/or base_url_anthropic
env_var         = "MYPROXY_API_KEY"              # name of the resident env var - the value is never stored
```

Then `mc run --gateway myproxy ...` (claude-code, codex, kimi-code today; pi and
opencode are openrouter-only for now), and `mc harness check <name> --gateway myproxy`
proves the wiring against the real CLI before you rely on it.

## Notifications

One push per finished run, carrying `exit` - and, when a run doesn't succeed, the
reason it ended (exit code, budget cap, harness error, or a dead supervisor), so you
learn why without digging through logs:

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

- [docs/agents.md](./docs/agents.md) - operating guide for agents driving mc: good
  practices distilled from real fleet operation (also linked from `mc help`)
- [SPEC.md](./SPEC.md) - full design: adapters, verification, auth, cost model
- [CONTEXT.md](./CONTEXT.md) - domain glossary
- [docs/adr/](./docs/adr/) - decisions and their reasons

State lives in `~/.mission-control/` (`MC_HOME` to relocate). `npm test` runs the full
e2e suite against stub CLIs - no API cost. Development: `node src/mc.ts …` runs
straight from source; `npm run build` refreshes the committed `dist/`.

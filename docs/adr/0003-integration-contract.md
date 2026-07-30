# 0003: Integration contract - three generic seams

Date: 2026-07-27
Status: accepted

## Context

Two orchestrator stacks now drive mc in production: the OpenClaw bot and the
Hermes agent, each on its own host. A verified fleet analysis (36 runs) showed
both stacks integrating through ad-hoc means - hermes polling `mc show` from
its own scheduler and hand-rolling checkpoint restarts with raw git, openclaw
abandoning mc entirely for lack of a completion signal. The temptation is to
"support" these stacks directly. That would couple mc to tools it must outlive
(the operator requirement: compatible with hermes/openclaw, never tied to
them, fully usable without them).

## Decision

mc integrates with any orchestrator through exactly three generic seams, and
nothing else:

1. **Push** - `[notify] exec/webhook` in config.toml: one JSON payload per
   terminal transition, at-least-once, `notify_result` recording per-channel
   truth. Pointing the hook at a given stack's wake endpoint is the
   OPERATOR's config, never mc code. Examples live in `docs/integrations/`.
2. **Pull** - the data contract: the SQLite ledger (`runs`, `events`), the
   run-dir layout, `mc ls --json` / `mc show`. Any tool in any language reads
   run state without mc's involvement or knowledge.
3. **Drive** - the CLI (and its stdin `--spec -` form) today; `mc mcp` later
   if an MCP-speaking orchestrator materializes (deliberately deferred - no
   current consumer).

Consequences of the boundary:

- No stack-specific code paths, config keys, event kinds, or vocabulary in mc,
  ever. A new orchestrator costs mc nothing.
- Stack examples ship as documentation (`docs/integrations/<stack>.md`), the
  way the SPEC always shipped a Telegram example: configs, not code.
- Continuation logic (watchdogs, retry-on-incomplete, escalation) belongs to
  the orchestrator. mc's obligations end at: reliable terminal push, an
  honest `exit` (never the agent's own claim of success), and tracked
  continuation primitives (`mc resume`, `mc resume --fresh`) so the
  orchestrator's loop never needs untracked side operations.
- mc must stay fully usable with zero orchestrator: the CLI alone remains the
  complete product.

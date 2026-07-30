# Mission Control

The control plane for delegated agent work: a per-host ledger of runs that mission-control
itself launched on coding-agent harnesses, with push delivery of the result. It exists
because delegated work was previously untracked glue: no durable record of what ran,
where, for how much, and whether the process itself actually finished cleanly.

## Language

**Naming principle** (decided 2026-07-22): stay as close as possible to Claude Code's
own vocabulary with as little invented abstraction as possible. A field gets an mc-specific
name only when mc adds real semantics (cost_basis, Harness). Hence `prompt` not
"goal", `session_id` not "session_ref".

**Run**:
A unit of delegated work that mission-control launched; exactly one harness session.
Work not launched by mission-control is outside the system by definition, and subagents a
harness spawns internally are inside the Run, never rows of their own (their cost rolls
up; agentsview renders their trees). Run lineage (`parent_run_id`) means mc-level lineage
only: resume chains, and mc-spawned children later.
_Avoid_: task, job, session

**Harness**:
A coding-agent CLI that mission-control can launch headlessly (claude-code, codex, pi):
it runs an agent loop against a workspace and produces a supervisable process with a
real exit status. A bare LLM API call is not a Harness — there is no workspace, no
process, nothing for a Supervisor to watch to termination. Mission-control never runs
an agent loop itself.
_Avoid_: agent, model, backend

**Adapter**:
The per-harness module that owns the golden invocation, translates native output into the
event union, and declares capabilities.
_Avoid_: driver, plugin, provider

**Supervisor**:
The detached per-run process that watches one Run to termination: tails events, enforces
budget/wall-clock caps, classifies the exit, fires the notification, exits.
_Avoid_: daemon, watcher

**Exit**:
What the run's process did: succeeded, failed, killed, lost. Derived from the process's
real termination (exit code, signal, kill request), never from the agent's own claim of
success — a harness that exits 0 on an errored final turn (pi, confirmed) still lands
`failed`. Says nothing about the quality of the output; that judgment belongs to the
operator or the orchestrating agent.
_Avoid_: status, result, verdict, QA

**Host**:
The single machine a Run belongs to. Ids, ledger, lineage, and notifications are
host-local; "the fleet" is not a concept — cross-host views exist only in whatever
aggregates the per-host ledgers. Resume chains never cross hosts.
_Avoid_: fleet, cluster

**Operator**:
The human driving mission-control (directly or through an Orchestrator).

**Orchestrator**:
Any agent that drives mission-control from outside — a Claude Code session via MCP, a
claw's agent shelling out to the CLI. Always outside the edge: an Orchestrator is never a
Run and mission-control never supplies one.
_Avoid_: main agent, dispatcher

**Gateway**:
An LLM routing proxy (OpenRouter or compatible) that a Run's model traffic is sent
through; one of the three auth modes. Unrelated to OpenClaw's "Gateway" daemon, which is
outside mission-control's world entirely.
_Avoid_: proxy, shim

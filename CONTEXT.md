# Mission Control

The control plane for delegated agent work: a per-host ledger of runs that mission-control
itself launched on coding-agent harnesses, with independent verification and push delivery.
It exists because self-reported agent success is unreliable and delegated work was
previously untracked glue.

## Language

**Run**:
A unit of delegated work that mission-control launched; exactly one harness session.
Work not launched by mission-control is outside the system by definition, and subagents a
harness spawns internally are inside the Run, never rows of their own (their cost rolls
up; agentsview renders their trees). Run lineage (`parent_run_id`) means mc-level lineage
only: resume chains, and mc-spawned children later.
_Avoid_: task, job, session

**Harness**:
A coding-agent CLI that mission-control can launch headlessly (claude-code, codex, pi):
it runs an agent loop against a workspace and produces checkable effects. A bare LLM API
call is not a Harness — with nothing for the verifier to bite on, it stays outside the
edge. Mission-control never runs an agent loop itself.
_Avoid_: agent, model, backend

**Adapter**:
The per-harness module that owns the golden invocation, translates native output into the
event union, and declares capabilities.
_Avoid_: driver, plugin, provider

**Supervisor**:
The detached per-run process that watches one Run to termination: tails events, enforces
budget/wall-clock caps, runs the verifier, fires the notification, exits.
_Avoid_: daemon, watcher

**Exit**:
What the run's process did: succeeded, failed, killed, lost. One of the two status axes;
says nothing about whether the claim is true.

**Verdict**:
Whether the checks the RunSpec declared passed, confirmed mechanically and independently
of the agent's claims: verified, failed_verification, unverifiable, needs_human_look.
Verified promises nothing about quality or taste — that judgment belongs to the operator
or the orchestrating agent, and subjective work terminates at needs_human_look.
_Avoid_: status, result, QA

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

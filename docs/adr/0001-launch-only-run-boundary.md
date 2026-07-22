# 0001: Launch-only Run boundary

Date: 2026-07-20
Status: accepted

## Context

Mission-control needs a definition of which work is inside its world. Three candidates:
track only what it launches; additionally allow adopting externally started harness
sessions (`mc adopt <pid>`); or observe every harness session on the host
(agentsview-style discovery). The evidence corpus that motivated mc is full of
hand-started, untracked runs, so "make mc see everything" was a live temptation.

## Decision

A Run exists if and only if mission-control launched it. One Run = one harness session;
subagents a harness spawns internally are inside the Run, never rows. Bare LLM API calls
are not Runs (no workspace, nothing to verify). Hosts stand alone: no fleet concept, no
cross-host ids or lineage.

## Consequences

- Every Run row carries the full guarantees: an archived spec, declared checks, a
  supervisor that watched it end-to-end, a meaningful verdict. No second, weaker class of
  row exists.
- Hand-started work stays untracked by design; the remedy is "launch it through mc," not
  adoption. Historical visibility of everything else is agentsview's job, reachable via
  session_id.
- The ledger's semantics never depend on harness-specific discovery heuristics, which is
  what made openclaw's two-schema split (native vs ACP) unfixable.
- If a genuine adoption need emerges, it must come back through this ADR, likely as an
  explicitly labeled unverifiable row class rather than a loosened Run definition.

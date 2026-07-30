export type ExitStatus = "queued" | "running" | "succeeded" | "failed" | "killed" | "lost";

export type AuthMode = "subscription" | "api_key" | "gateway";

export type CostBasis = "flat_subscription" | "metered_reported" | "unavailable";

export interface RunSpec {
  harness: string;
  model: string | null;
  prompt: string;
  cwd: string | null;
  /** Declared deliverables, workdir-relative; injected into the prompt so the harness knows where to write. */
  artifacts: string[];
  budget_usd: number | null;
  max_minutes: number | null;
  /** Stall cap: kill when the harness emits nothing for this long. null = default (30); 0 = disabled. */
  max_idle_minutes: number | null;
  auth: { mode: AuthMode; gateway?: string };
}

export interface Run {
  id: string;
  parent_run_id: string | null;
  root_run_id: string;
  harness: string;
  model: string | null;
  host: string;
  prompt: string;
  title: string;
  spec_path: string;
  workdir: string;
  session_id: string | null;
  exit: ExitStatus;
  started_at: string;
  ended_at: string | null;
  cost_usd: number | null;
  cost_basis: CostBasis;
  tokens_in: number | null;
  tokens_out: number | null;
  budget_usd: number | null;
  max_minutes: number | null;
  max_idle_minutes: number | null;
  auth_mode: AuthMode;
  gateway: string | null;
  pid: number | null;
  supervisor_pid: number | null;
  stderr_path: string;
  artifacts: string[];
  notified: boolean;
}

export type Disposition = "accepted" | "retry" | "blocked";

/**
 * An attributed, append-only judgment recorded against a TERMINAL run - never
 * written by any internal mc code path, only by `mc assess` on an operator's
 * or reviewer's say-so. See db.ts's assessments table comment for the full
 * set of principles this type encodes.
 */
export interface Assessment {
  run_id: string;
  seq: number;
  ts: string;
  reviewer: string;
  disposition: Disposition;
  checkpoint_sha: string | null;
  evidence: { path: string; sha256: string }[];
  note: string | null;
  /** What mc itself observed recording this assessment (os user@host) - distinct from `reviewer`, which is merely asserted. */
  observed: string | null;
  notified: boolean;
}

export const EVENT_KINDS = [
  "started",
  "text",
  "tool_call",
  "tool_result",
  "subagent",
  "turn_end",
  "cost_update",
  "artifact",
  "status_change",
  "notify_result",
  "error",
  "exited",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface RunEvent {
  run_id: string;
  seq: number;
  ts: string;
  kind: EventKind;
  payload: unknown;
}

export interface Capabilities {
  resume: "none" | "native";
  steering: "none";
  cost_reporting: "per_run" | "none";
  /** Whether the native stream carries token counts mc can extract at all. */
  tokens_reporting: "reported" | "none";
  effort_passthrough: "honored" | "stripped_for_non_anthropic" | "unknown";
  sandbox: "flag" | "none";
  auth_modes: AuthMode[];
}

/** Preflight failures are user errors: named, actionable, never a stack trace. */
export class PreflightError extends Error {}

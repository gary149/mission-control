export type ExitStatus = "queued" | "running" | "succeeded" | "failed" | "killed" | "lost";

export type Verdict =
  | "pending"
  | "verified"
  | "failed_verification"
  | "unverifiable"
  | "needs_human_look";

export type AuthMode = "subscription" | "api_key" | "gateway";

export type CostBasis = "flat_subscription" | "metered_reported" | "unavailable";

export interface RunSpec {
  harness: string;
  model: string | null;
  goal: string;
  cwd: string | null;
  artifacts: string[];
  visual: boolean;
  budget_usd: number | null;
  max_minutes: number | null;
  auth: { mode: AuthMode; gateway?: string };
}

export interface Run {
  id: string;
  parent_run_id: string | null;
  root_run_id: string;
  harness: string;
  model: string | null;
  host: string;
  goal: string;
  title: string;
  spec_path: string;
  workdir: string;
  session_ref: string | null;
  exit: ExitStatus;
  verdict: Verdict;
  started_at: string;
  ended_at: string | null;
  cost_usd: number | null;
  cost_basis: CostBasis;
  tokens_in: number | null;
  tokens_out: number | null;
  budget_usd: number | null;
  max_minutes: number | null;
  auth_mode: AuthMode;
  gateway: string | null;
  pid: number | null;
  stderr_path: string;
  artifacts: string[];
  verify_evidence: string | null;
  notified: boolean;
}

export const EVENT_KINDS = [
  "started",
  "text",
  "tool_call",
  "tool_result",
  "turn_end",
  "cost_update",
  "artifact",
  "status_change",
  "verify_result",
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
  effort_passthrough: "honored" | "stripped_for_non_anthropic" | "unknown";
  sandbox: "flag" | "none";
  auth_modes: AuthMode[];
}

/** Preflight failures are user errors: named, actionable, never a stack trace. */
export class PreflightError extends Error {}

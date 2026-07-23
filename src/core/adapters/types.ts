import type { GatewayConfig } from "../config.ts";
import type { Capabilities, EventKind, RunSpec } from "../types.ts";

export interface Detection {
  installed: boolean;
  path?: string;
  version?: string;
}

/** Resolved, non-secret except credential.value, which exists only in memory. */
export interface LaunchContext {
  spec: RunSpec;
  binPath: string;
  gatewayCfg?: GatewayConfig;
  credential?: { envVar: string; value: string };
  workdir: string;
  /** Harness-native session reference to resume (mc resume); adapter maps it to native flags. */
  resumeSessionId?: string;
}

export interface MappedLine {
  events: { kind: EventKind; payload: unknown }[];
  update?: {
    session_id?: string;
    /** Absolute totals (harness reports a final figure once, e.g. claude's result event). */
    cost_usd?: number;
    tokens_in?: number;
    tokens_out?: number;
    /** Per-turn increments (harness reports per turn, e.g. pi/codex); supervisor accumulates. */
    cost_usd_delta?: number;
    tokens_in_delta?: number;
    tokens_out_delta?: number;
    result_text?: string;
  };
}

export interface HarnessAdapter {
  name: string;
  capabilities: Capabilities;
  detect(): Detection;
  /**
   * The golden invocation: full argv + the mode-specific env keys.
   * Env is ONLY what this returns; the supervisor adds the {PATH, HOME, LANG,
   * TERM} baseline and nothing else (additive-from-empty, never inherited).
   */
  buildCommand(ctx: LaunchContext): { argv: string[]; env: Record<string, string> };
  /** Translate one native stdout line into normalized events. Never throws. */
  mapLine(line: string): MappedLine;
}

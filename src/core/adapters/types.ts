import type { GatewayConfig } from "../config";
import type { Capabilities, EventKind, RunSpec } from "../types";

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
}

export interface MappedLine {
  events: { kind: EventKind; payload: unknown }[];
  update?: {
    session_ref?: string;
    cost_usd?: number;
    tokens_in?: number;
    tokens_out?: number;
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

import { PreflightError } from "../types.ts";
import type { HarnessAdapter } from "./types.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { kimiCode } from "./kimi-code.ts";
import { opencode } from "./opencode.ts";
import { pi } from "./pi.ts";

/** Static compile-time registry; no dynamic plugin loading (SPEC decision). */
export const ADAPTERS: HarnessAdapter[] = [claudeCode, codex, kimiCode, opencode, pi];

export function getAdapter(name: string): HarnessAdapter {
  const adapter = ADAPTERS.find((a) => a.name === name);
  if (!adapter) {
    const known = ADAPTERS.map((a) => a.name).join(", ");
    throw new PreflightError(`unknown harness "${name}" (registered: ${known})`);
  }
  return adapter;
}

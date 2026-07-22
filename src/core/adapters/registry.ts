import { PreflightError } from "../types";
import type { HarnessAdapter } from "./types";
import { claudeCode } from "./claude-code";
import { codex } from "./codex";
import { pi } from "./pi";

/** Static compile-time registry; no dynamic plugin loading (SPEC decision). */
export const ADAPTERS: HarnessAdapter[] = [claudeCode, codex, pi];

export function getAdapter(name: string): HarnessAdapter {
  const adapter = ADAPTERS.find((a) => a.name === name);
  if (!adapter) {
    const known = ADAPTERS.map((a) => a.name).join(", ");
    throw new PreflightError(`unknown harness "${name}" (registered: ${known})`);
  }
  return adapter;
}

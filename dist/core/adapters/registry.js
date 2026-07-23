import { PreflightError } from "../types.js";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { pi } from "./pi.js";
/** Static compile-time registry; no dynamic plugin loading (SPEC decision). */
export const ADAPTERS = [claudeCode, codex, pi];
export function getAdapter(name) {
    const adapter = ADAPTERS.find((a) => a.name === name);
    if (!adapter) {
        const known = ADAPTERS.map((a) => a.name).join(", ");
        throw new PreflightError(`unknown harness "${name}" (registered: ${known})`);
    }
    return adapter;
}

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectTimeoutMs } from "./detect-timeout.js";
/**
 * pi adapter, grounded in pi 0.81.0 `-p --mode json` (probed live):
 *   {"type":"session","version":3,"id":"<uuid>","cwd":...}       first line
 *   {"type":"turn_end","message":{usage:{input,output,totalTokens,cost:{total}}}}
 *   plus streaming noise (message_update, text_delta, toolcall_delta,
 *   tool_execution_update, ...) - all benign, must not trip parser health
 * pi computes a real dollar figure client-side per turn - the one harness where
 * cost is genuinely metered in every auth mode, so --budget is enforceable.
 * Sessions: --session-dir <dir> stores the session file; --session <id> resumes.
 */
function resolveBin() {
    if (process.env.MC_PI_BIN)
        return process.env.MC_PI_BIN;
    const which = spawnSync("which", ["pi"], { encoding: "utf8" });
    const path = which.status === 0 ? which.stdout.trim() : "";
    return path || null;
}
export const pi = {
    name: "pi",
    capabilities: {
        resume: "native",
        steering: "none",
        cost_reporting: "per_run",
        tokens_reporting: "reported",
        effort_passthrough: "unknown",
        sandbox: "none",
        auth_modes: ["subscription", "gateway"], // api_key deliberately absent: pi has an
        // --api-key flag but argv leaks via process listings; auth.json covers every case
    },
    detect() {
        const path = resolveBin();
        if (!path)
            return { installed: false };
        const v = spawnSync(path, ["--version"], { encoding: "utf8", timeout: detectTimeoutMs() });
        const runnable = v.status === 0 && !v.error;
        return { installed: runnable, path, version: v.stdout?.trim() || undefined };
    },
    buildCommand(ctx) {
        const { spec } = ctx;
        const env = {};
        if (ctx.credential)
            env[ctx.credential.envVar] = ctx.credential.value;
        // Session files live inside the run dir: host-local, per-run, and the
        // resume lookup (--session <id> against --session-dir) stays self-contained.
        // Resume runs reuse the parent's workdir, hence the parent's session dir.
        const sessionDir = join(dirname(ctx.workdir), "pi-session");
        mkdirSync(sessionDir, { recursive: true });
        const argv = [ctx.binPath, "-p", "--mode", "json", "--session-dir", sessionDir];
        if (spec.auth.mode === "gateway")
            argv.push("--provider", ctx.gatewayCfg.name);
        if (spec.model)
            argv.push("--model", spec.model);
        if (ctx.resumeSessionId)
            argv.push("--session", ctx.resumeSessionId);
        let prompt = spec.prompt;
        if (spec.artifacts.length > 0) {
            prompt += `\n\nWrite the deliverables to these exact paths (relative to the working directory): ${spec.artifacts.join(", ")}`;
        }
        argv.push(prompt);
        return { argv, env };
    },
    mapLine(line) {
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            return { events: [{ kind: "error", payload: { note: "unparsed", raw: line.slice(0, 2000) } }] };
        }
        const events = [];
        let update;
        switch (obj?.type) {
            case "session":
                events.push({ kind: "started", payload: { session_id: obj.id } });
                if (obj.id)
                    update = { session_id: obj.id };
                break;
            // Streaming/progress noise, deliberately skipped:
            case "agent_start":
            case "agent_end":
            case "agent_settled":
            case "turn_start":
            case "message_start":
            case "message_update":
            case "message_end":
            case "text_delta":
            case "text":
            case "thinking":
            case "toolcall_start":
            case "toolcall_delta":
            case "tool_execution_start":
            case "tool_execution_update":
            // Real members of pi's AgentSessionEvent union (confirmed against the
            // installed @earendil-works/pi-coding-agent 0.81.0 type defs), fired on
            // ordinary long runs - compaction, retries, the message queue, session
            // metadata. Previously unhandled: fell to `default` and logged a noisy
            // unknown-native-event error on every run long enough to trigger them.
            case "queue_update":
            case "compaction_start":
            case "compaction_end":
            case "auto_retry_start":
            case "auto_retry_end":
            case "entry_appended":
            case "session_info_changed":
            case "thinking_level_changed":
                break;
            case "toolcall_end": {
                const call = obj.toolCall ?? obj.message?.content?.find?.((c) => c?.type === "toolCall") ?? {};
                events.push({
                    kind: "tool_call",
                    payload: { name: call.name ?? "tool", input: JSON.stringify(call.arguments ?? {}).slice(0, 2000) },
                });
                break;
            }
            case "tool_execution_end": {
                const raw = typeof obj.result === "string" ? obj.result : JSON.stringify(obj.result ?? obj.output ?? "");
                events.push({ kind: "tool_result", payload: { excerpt: raw.slice(0, 500) } });
                break;
            }
            case "turn_end": {
                const message = obj.message ?? {};
                const usage = message.usage ?? {};
                // pi exits 0 even when the turn errored or was aborted (observed live:
                // OAuth refresh failure with stopReason "error"; "aborted" is the same
                // terminal shape per pi's StopReason type) - surface it, never let it
                // pass as a clean turn. `usage` is a required field on the terminal
                // AssistantMessage in EVERY stop reason (including error/aborted), so
                // it is recorded here too - dropping it would silently understate
                // cost_usd/tokens and let a run coast under --budget on its way out.
                const isError = message.stopReason === "error" || message.stopReason === "aborted";
                if (isError) {
                    events.push({
                        kind: "error",
                        payload: {
                            note: "harness-error",
                            message: String(message.errorMessage ?? `turn ${message.stopReason}`).slice(0, 500),
                        },
                    });
                }
                else {
                    const text = Array.isArray(message.content)
                        ? message.content
                            .filter((c) => c?.type === "text" && c.text)
                            .map((c) => c.text)
                            .join("\n")
                        : "";
                    if (text)
                        events.push({ kind: "text", payload: { text: text.slice(0, 2000) } });
                }
                const costTotal = usage.cost?.total;
                update = {
                    cost_usd_delta: typeof costTotal === "number" && costTotal > 0 ? costTotal : undefined,
                    tokens_in_delta: typeof usage.input === "number" ? usage.input : undefined,
                    tokens_out_delta: typeof usage.output === "number" ? usage.output : undefined,
                };
                events.push({
                    kind: "cost_update",
                    payload: { cost_usd: costTotal ?? null, tokens_in: usage.input ?? null, tokens_out: usage.output ?? null },
                });
                events.push({ kind: "turn_end", payload: { is_error: isError, stop_reason: message.stopReason } });
                break;
            }
            case "error":
                events.push({ kind: "error", payload: { note: "harness-error", raw: line.slice(0, 2000) } });
                // Defensive: this top-level shape is not grounded in observed pi output
                // (unlike the stopReason path above). If it IS terminal, synthesize
                // turn_end like codex/opencode so a cleanly parsed failure never lands
                // unverifiable on parser health alone.
                events.push({ kind: "turn_end", payload: { is_error: true } });
                break;
            default:
                events.push({ kind: "error", payload: { note: "unknown-native-event", raw: line.slice(0, 2000) } });
        }
        return { events, update };
    },
};

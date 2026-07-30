import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectTimeoutMs } from "./detect-timeout.js";
/**
 * kimi-code adapter, grounded in kimi-code 0.29.2 `-p --output-format stream-json`
 * (probed live):
 *   {"role":"assistant","tool_calls":[{"type":"function","id":"Write_0","function":{"name":"Write","arguments":"{...}"}}]}
 *   {"role":"tool","tool_call_id":"Write_0","content":"Wrote 9 bytes to hello.txt"}
 *   {"role":"assistant","content":"..."}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>","command":"kimi -r <id>","content":"..."}
 * No session-start event, no turn-complete event, and no token/cost telemetry on
 * stdout in any mode - hence cost_reporting and tokens_reporting are "none" (a
 * stream fact, not a not-yet). The resume_hint is the only end-of-run marker, so
 * it doubles as turn_end; upstream #1897 can drop it on signal shutdown, which
 * degrades the run to unverifiable - the correct fail direction.
 * Failures exit 1 with an EMPTY stdout and the error on stderr (probed live).
 * `-p` is always full-auto (no bypass flag exists or is accepted); config deny
 * rules would be the only brake, and mc's scratch home has none.
 * Credentials/model: the CLI ignores conventional env keys entirely; the only
 * env channel is the KIMI_MODEL_* family, which synthesizes an in-memory
 * provider+model for one run - nothing secret ever written to disk.
 */
function resolveBin() {
    if (process.env.MC_KIMI_BIN)
        return process.env.MC_KIMI_BIN;
    const which = spawnSync("which", ["kimi"], { encoding: "utf8" });
    const path = which.status === 0 ? which.stdout.trim() : "";
    return path || null;
}
export const kimiCode = {
    name: "kimi-code",
    capabilities: {
        resume: "native",
        steering: "none",
        cost_reporting: "none",
        tokens_reporting: "none",
        effort_passthrough: "unknown",
        sandbox: "none",
        auth_modes: ["api_key", "gateway"], // subscription (Kimi OAuth) deferred until
        // a real `kimi login` exists to verify the credential layout against
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
        // Per-run scratch state root (KIMI_CODE_HOME relocates config, sessions,
        // credentials, logs wholesale): full isolation from any resident
        // ~/.kimi-code. Resume runs reuse the parent's workdir and therefore the
        // parent's scratch home, keeping session files reachable.
        const home = join(dirname(ctx.workdir), "kimi-home");
        mkdirSync(home, { recursive: true });
        const env = { KIMI_CODE_HOME: home };
        // kimi reads credentials only through the KIMI_MODEL_* family; the resolved
        // credential's own env var name would be silently ignored.
        if (ctx.credential)
            env.KIMI_MODEL_API_KEY = ctx.credential.value;
        // Preflight guarantees a model for both supported auth modes (the scratch
        // home has no config.toml, so there is no default_model to fall back to).
        if (spec.model)
            env.KIMI_MODEL_NAME = spec.model;
        if (spec.auth.mode === "gateway") {
            env.KIMI_MODEL_PROVIDER_TYPE = "openai";
            env.KIMI_MODEL_BASE_URL = ctx.gatewayCfg.base_url_openai;
        }
        else {
            env.KIMI_MODEL_PROVIDER_TYPE = "kimi";
            env.KIMI_MODEL_BASE_URL = "https://api.moonshot.ai/v1";
        }
        let prompt = spec.prompt;
        if (spec.artifacts.length > 0) {
            prompt += `\n\nWrite the deliverables to these exact paths (relative to the working directory): ${spec.artifacts.join(", ")}`;
        }
        const argv = [ctx.binPath, "-p", prompt, "--output-format", "stream-json"];
        if (ctx.resumeSessionId)
            argv.push("--session", ctx.resumeSessionId);
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
        switch (obj?.role) {
            case "assistant": {
                if (obj.content) {
                    events.push({ kind: "text", payload: { text: String(obj.content).slice(0, 2000) } });
                }
                for (const call of obj.tool_calls ?? []) {
                    events.push({
                        kind: "tool_call",
                        payload: { name: call?.function?.name ?? "tool", input: String(call?.function?.arguments ?? "").slice(0, 2000) },
                    });
                }
                break;
            }
            case "tool": {
                const raw = typeof obj.content === "string" ? obj.content : JSON.stringify(obj.content ?? "");
                events.push({ kind: "tool_result", payload: { excerpt: raw.slice(0, 500) } });
                break;
            }
            case "meta": {
                if (obj.type === "session.resume_hint") {
                    // The only end-of-run marker in the stream - doubles as turn_end and
                    // the sole source of session_id. If it is lost (upstream #1897), the
                    // run still completes, just with no session_id captured for resume.
                    if (obj.session_id)
                        update = { session_id: obj.session_id };
                    events.push({ kind: "turn_end", payload: { is_error: false } });
                }
                else if (obj.type === "turn.step.retrying" || obj.type === "system.version") {
                    break; // benign: provider retry notices, experimental version banner
                }
                else {
                    events.push({ kind: "error", payload: { note: "unknown-native-event", raw: line.slice(0, 2000) } });
                }
                break;
            }
            default:
                events.push({ kind: "error", payload: { note: "unknown-native-event", raw: line.slice(0, 2000) } });
        }
        return { events, update };
    },
};

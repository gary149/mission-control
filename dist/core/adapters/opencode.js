import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * opencode adapter, grounded in opencode 1.18.7 `run --format json --auto`
 * (probed live on the openclaw host via OpenRouter):
 *   {"type":"step_start","timestamp":...,"sessionID":"ses_...","part":{...}}
 *   {"type":"tool_use",...,"part":{"type":"tool","tool":"write","state":{"status":"completed","input":{...},"output":"..."}}}
 *   {"type":"step_finish",...,"part":{"reason":"tool-calls"|"stop","tokens":{"input","output","reasoning","cache"},"cost":0.02}}
 *   {"type":"text",...,"part":{"type":"text","text":"..."}}
 *   {"type":"error",...,"error":{"name":"...","data":{"message":"..."}}}
 * Every envelope carries sessionID, so session capture never depends on one
 * lucky line. There is NO explicit done/idle event in json mode; step_finish is
 * the per-step boundary (every step emits exactly one, even tool-less turns)
 * and doubles as turn_end - several per run, deltas summed, the pi model.
 * step_finish cost/tokens are PER-STEP DELTAS (probed: 0.0217/0.0056/0.0051
 * across three steps, input 6477/472/621 - a cumulative series would grow),
 * with sane nonzero OpenRouter figures, so gateway cost is genuinely metered.
 * `--auto` (1.18.x name; older releases spelled it --dangerously-skip-
 * permissions) auto-approves permission requests server-side; without it run
 * mode auto-REJECTS rather than hangs. Failures exit 1 with a single cleanly
 * parsed error envelope (probed live).
 */
function resolveBin() {
    if (process.env.MC_OPENCODE_BIN)
        return process.env.MC_OPENCODE_BIN;
    const which = spawnSync("which", ["opencode"], { encoding: "utf8" });
    const path = which.status === 0 ? which.stdout.trim() : "";
    return path || null;
}
export const opencode = {
    name: "opencode",
    capabilities: {
        resume: "native",
        steering: "none",
        cost_reporting: "per_run",
        tokens_reporting: "reported",
        effort_passthrough: "unknown",
        sandbox: "none",
        auth_modes: ["subscription", "gateway"], // api_key deliberately absent: opencode
        // resolves the credential env var per --model's provider prefix (a dozen
        // possible names); mc's one-var-per-harness table cannot express that honestly
    },
    detect() {
        const path = resolveBin();
        if (!path)
            return { installed: false };
        const v = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
        const runnable = v.status === 0 && !v.error;
        return { installed: runnable, path, version: v.stdout?.trim() || undefined };
    },
    buildCommand(ctx) {
        const { spec } = ctx;
        const env = {
            // Patch releases self-upgrade in place mid-run otherwise - the same
            // silent-relocation failure class claude-code's DISABLE_AUTOUPDATER guards.
            OPENCODE_DISABLE_AUTOUPDATE: "1",
        };
        let model = spec.model ?? undefined;
        if (spec.auth.mode === "gateway") {
            // Full state isolation: fresh XDG roots so the child can never read (or
            // write into) the resident ~/.local/share/opencode auth.json/session db.
            // Resume runs reuse the parent's workdir and therefore this same scratch
            // root, keeping the isolated session store reachable.
            const home = join(dirname(ctx.workdir), "opencode-home");
            for (const sub of ["data", "config", "cache", "state"])
                mkdirSync(join(home, sub), { recursive: true });
            env.XDG_DATA_HOME = join(home, "data");
            env.XDG_CONFIG_HOME = join(home, "config");
            env.XDG_CACHE_HOME = join(home, "cache");
            env.XDG_STATE_HOME = join(home, "state");
            // opencode reads each provider's key from whichever env var models.dev
            // names for it; for its builtin openrouter provider that is literally
            // OPENROUTER_API_KEY - a differently-named credential would be ignored.
            if (ctx.credential)
                env.OPENROUTER_API_KEY = ctx.credential.value;
            // -m format is <opencode-provider>/<model>; mc's gateway model id is
            // already OpenRouter-native (e.g. moonshotai/kimi-k3), so prepend the
            // builtin provider id. Must match auth.ts's openrouter-only restriction.
            if (spec.model)
                model = `openrouter/${spec.model}`;
        }
        // subscription mode: no isolation and no injected credential at all - the
        // resident auth.json and config are exactly what "resident login" means.
        let prompt = spec.prompt;
        if (spec.artifacts.length > 0) {
            prompt += `\n\nWrite the deliverables to these exact paths (relative to the working directory): ${spec.artifacts.join(", ")}`;
        }
        const argv = [ctx.binPath, "run", "--format", "json", "--auto"];
        if (model)
            argv.push("-m", model);
        if (ctx.resumeSessionId)
            argv.push("-s", ctx.resumeSessionId);
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
        // Every envelope carries the session id; capture it from any recognized line.
        const capture = () => {
            if (typeof obj.sessionID === "string" && obj.sessionID)
                update = { ...update, session_id: obj.sessionID };
        };
        switch (obj?.type) {
            case "step_start":
                capture();
                break; // benign per-step marker, no data worth surfacing
            case "tool_use": {
                capture();
                const state = obj.part?.state ?? {};
                events.push({
                    kind: "tool_call",
                    payload: { name: obj.part?.tool ?? "tool", input: JSON.stringify(state.input ?? {}).slice(0, 2000) },
                });
                const raw = state.status === "error" ? String(state.error ?? "") : String(state.output ?? "");
                events.push({ kind: "tool_result", payload: { excerpt: raw.slice(0, 500), status: state.status } });
                break;
            }
            case "text":
            case "reasoning": {
                capture();
                const text = String(obj.part?.text ?? "");
                if (text) {
                    events.push({
                        kind: "text",
                        payload: obj.type === "reasoning" ? { text: text.slice(0, 2000), reasoning: true } : { text: text.slice(0, 2000) },
                    });
                }
                break;
            }
            case "step_finish": {
                capture();
                const part = obj.part ?? {};
                const tokens = part.tokens ?? {};
                const cost = typeof part.cost === "number" && part.cost > 0 ? part.cost : undefined;
                update = {
                    ...update,
                    cost_usd_delta: cost,
                    tokens_in_delta: typeof tokens.input === "number" ? tokens.input : undefined,
                    tokens_out_delta: typeof tokens.output === "number" ? tokens.output : undefined,
                };
                events.push({
                    kind: "cost_update",
                    payload: { cost_usd: part.cost ?? null, tokens_in: tokens.input ?? null, tokens_out: tokens.output ?? null },
                });
                events.push({ kind: "turn_end", payload: { is_error: false, reason: part.reason } });
                break;
            }
            case "error": {
                capture();
                const err = obj.error ?? {};
                const message = String(err.data?.message ?? err.name ?? "unknown error");
                events.push({ kind: "error", payload: { note: "harness-error", message: message.slice(0, 500) } });
                // Synthesized so a cleanly parsed failure never degrades parser health.
                events.push({ kind: "turn_end", payload: { is_error: true } });
                break;
            }
            default:
                events.push({ kind: "error", payload: { note: "unknown-native-event", raw: line.slice(0, 2000) } });
        }
        return { events, update };
    },
};

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * codex adapter, grounded in codex-cli 0.144.6 `exec --json` (probed live):
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"item.started"|"item.completed","item":{type:"agent_message"|"command_execution"|"file_change",...}}
 *   {"type":"turn.completed","usage":{input_tokens,cached_input_tokens,output_tokens,...}}
 * No dollar figure in any event (cost_reporting: none is permanent, not "not yet").
 * Resume: `codex exec resume <SESSION_ID> <prompt>` (verified in --help).
 */
function resolveBin() {
    if (process.env.MC_CODEX_BIN)
        return process.env.MC_CODEX_BIN;
    const which = spawnSync("which", ["codex"], { encoding: "utf8" });
    const fromPath = which.status === 0 ? which.stdout.trim() : "";
    if (fromPath)
        return fromPath;
    // codex commonly lives under an nvm-managed node absent from minimal PATHs.
    const nvm = spawnSync("sh", ["-c", 'ls "$HOME"/.nvm/versions/node/*/bin/codex 2>/dev/null | sort -V | tail -n1'], {
        encoding: "utf8",
    });
    const fromNvm = nvm.stdout.trim();
    return fromNvm || null;
}
export const codex = {
    name: "codex",
    capabilities: {
        resume: "native",
        steering: "none",
        cost_reporting: "none", // permanent: exec --json carries tokens only, never dollars
        effort_passthrough: "unknown",
        sandbox: "flag",
        auth_modes: ["subscription", "api_key", "gateway"],
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
        const env = {};
        if (spec.auth.mode !== "subscription") {
            // Fresh per-run CODEX_HOME: codex's api-key-vs-oauth precedence is
            // documented-buggy, so never let a cached ChatGPT auth.json sit next to
            // an explicit provider key. Resume runs reuse the parent's workdir and
            // therefore the parent's scratch home, keeping session files reachable.
            const scratch = join(dirname(ctx.workdir), "codex-home");
            mkdirSync(scratch, { recursive: true });
            env.CODEX_HOME = scratch;
        }
        if (ctx.credential)
            env[ctx.credential.envVar] = ctx.credential.value;
        const argv = [ctx.binPath, "exec"];
        if (ctx.resumeSessionId)
            argv.push("resume", ctx.resumeSessionId);
        argv.push("--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox");
        if (spec.auth.mode === "gateway") {
            const gw = ctx.gatewayCfg;
            argv.push("-c", `model_provider=${gw.name}`, "-c", `model_providers.${gw.name}.name=${gw.name}`, "-c", `model_providers.${gw.name}.base_url=${gw.base_url_openai}`, "-c", `model_providers.${gw.name}.env_key=${gw.env_var}`, "-c", `model_providers.${gw.name}.wire_api=${gw.wire_api}`);
        }
        else {
            // Pin the builtin provider so a custom default in the user's real
            // ~/.codex/config.toml can never silently hijack a subscription run.
            argv.push("-c", "model_provider=openai");
        }
        if (spec.model)
            argv.push("-m", spec.model);
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
            case "thread.started":
                events.push({ kind: "started", payload: { session_id: obj.thread_id } });
                if (obj.thread_id)
                    update = { session_id: obj.thread_id };
                break;
            case "turn.started":
            case "item.started":
            case "item.updated":
                break; // known-benign progress noise, deliberately skipped
            case "item.completed": {
                const item = obj.item ?? {};
                if (item.type === "agent_message" && item.text) {
                    events.push({ kind: "text", payload: { text: String(item.text).slice(0, 2000) } });
                }
                else if (item.type === "command_execution") {
                    events.push({ kind: "tool_call", payload: { name: "shell", input: String(item.command ?? "").slice(0, 2000) } });
                    events.push({
                        kind: "tool_result",
                        payload: { excerpt: String(item.aggregated_output ?? "").slice(0, 500), exit_code: item.exit_code },
                    });
                }
                else if (item.type === "file_change") {
                    events.push({
                        kind: "tool_call",
                        payload: { name: "file_change", input: JSON.stringify(item.changes ?? []).slice(0, 2000) },
                    });
                }
                else if (item.type === "reasoning") {
                    break; // benign
                }
                else {
                    events.push({ kind: "error", payload: { note: "unknown-native-event", raw: line.slice(0, 2000) } });
                }
                break;
            }
            case "turn.completed": {
                const usage = obj.usage ?? {};
                update = {
                    tokens_in_delta: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
                    tokens_out_delta: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
                };
                events.push({
                    kind: "cost_update",
                    payload: { cost_usd: null, tokens_in: usage.input_tokens ?? null, tokens_out: usage.output_tokens ?? null },
                });
                events.push({ kind: "turn_end", payload: { is_error: false } });
                break;
            }
            case "turn.failed":
            case "error":
                events.push({ kind: "error", payload: { note: "harness-error", raw: line.slice(0, 2000) } });
                events.push({ kind: "turn_end", payload: { is_error: true } });
                break;
            default:
                events.push({ kind: "error", payload: { note: "unknown-native-event", raw: line.slice(0, 2000) } });
        }
        return { events, update };
    },
};

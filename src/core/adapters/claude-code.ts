import { spawnSync } from "node:child_process";
import type { HarnessAdapter, Detection, LaunchContext, MappedLine } from "./types";

function resolveBin(): string | null {
  if (process.env.MC_CLAUDE_BIN) return process.env.MC_CLAUDE_BIN;
  const which = spawnSync("which", ["claude"], { encoding: "utf8" });
  const path = which.stdout.trim();
  return which.status === 0 && path ? path : null;
}

export const claudeCode: HarnessAdapter = {
  name: "claude-code",

  capabilities: {
    resume: "native",
    steering: "none",
    cost_reporting: "per_run",
    effort_passthrough: "stripped_for_non_anthropic",
    sandbox: "flag",
    auth_modes: ["subscription", "api_key", "gateway"],
  },

  detect(): Detection {
    const path = resolveBin();
    if (!path) return { installed: false };
    const v = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
    return { installed: true, path, version: v.stdout?.trim() || undefined };
  },

  buildCommand(ctx: LaunchContext) {
    const { spec } = ctx;
    const env: Record<string, string> = {
      DISABLE_AUTOUPDATER: "1",
      // Headless background waits die at a hardcoded 10-minute ceiling otherwise.
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "3600000",
    };

    if (ctx.credential) env[ctx.credential.envVar] = ctx.credential.value;

    // The resident login may live under a relocated config dir; the path is
    // non-secret and without it the child would look in ~/.claude instead.
    if (spec.auth.mode === "subscription" && process.env.CLAUDE_CONFIG_DIR) {
      env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    }

    if (spec.auth.mode === "gateway") {
      const gw = ctx.gatewayCfg!;
      const model = spec.model!;
      env.ANTHROPIC_BASE_URL = gw.base_url_anthropic;
      // credential.envVar is ANTHROPIC_AUTH_TOKEN here (set by auth resolution);
      // ANTHROPIC_API_KEY must not exist in this mode.
      env.ANTHROPIC_MODEL = model;
      env.ANTHROPIC_SMALL_FAST_MODEL = model;
      env.CLAUDE_CODE_SUBAGENT_MODEL = model;
    } else if (spec.model) {
      // Native modes: subagents follow an explicit model override; the
      // haiku/background lane intentionally stays at its cheap default.
      env.CLAUDE_CODE_SUBAGENT_MODEL = spec.model;
    }

    let prompt = spec.goal;
    if (spec.artifacts.length > 0) {
      prompt += `\n\nWrite the deliverables to these exact paths (relative to the working directory): ${spec.artifacts.join(", ")}`;
    }

    const argv = [
      ctx.binPath,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];
    if (spec.model && spec.auth.mode !== "gateway") argv.push("--model", spec.model);
    if (spec.auth.mode === "gateway") argv.push("--model", spec.model!);
    argv.push(prompt);
    return { argv, env };
  },

  mapLine(line: string): MappedLine {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return { events: [{ kind: "error", payload: { note: "unparsed", raw: line.slice(0, 2000) } }] };
    }

    const events: MappedLine["events"] = [];
    let update: MappedLine["update"];

    // Known-benign native noise, deliberately skipped (not format drift):
    // hook lifecycle chatter and internal thinking blocks.
    const BENIGN_SYSTEM = /^hook_/;

    switch (obj?.type) {
      case "system":
        if (obj.subtype === "init") {
          events.push({ kind: "started", payload: { session_id: obj.session_id, model: obj.model } });
          if (obj.session_id) update = { session_ref: obj.session_id };
        } else if (!BENIGN_SYSTEM.test(obj.subtype ?? "")) {
          events.push({ kind: "error", payload: { note: "unknown-native-event", raw: line.slice(0, 2000) } });
        }
        break;
      case "assistant": {
        for (const block of obj.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            events.push({ kind: "text", payload: { text: block.text } });
          } else if (block.type === "tool_use") {
            events.push({
              kind: "tool_call",
              payload: { name: block.name, input: JSON.stringify(block.input ?? {}).slice(0, 2000) },
            });
          } else if (block.type !== "thinking" && block.type !== "redacted_thinking" && block.type !== "text") {
            events.push({ kind: "error", payload: { note: "unknown-native-event", raw: JSON.stringify(block).slice(0, 2000) } });
          }
        }
        break;
      }
      case "user": {
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              const raw = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
              events.push({ kind: "tool_result", payload: { excerpt: raw.slice(0, 500) } });
            }
          }
        }
        break;
      }
      case "result": {
        update = {
          // 0 means "no meaningful figure" (auth failures report 0) - null, never 0.
          cost_usd: typeof obj.total_cost_usd === "number" && obj.total_cost_usd > 0 ? obj.total_cost_usd : undefined,
          tokens_in: obj.usage?.input_tokens,
          tokens_out: obj.usage?.output_tokens,
          result_text: typeof obj.result === "string" ? obj.result : undefined,
        };
        if (obj.session_id) update.session_ref = obj.session_id;
        events.push({
          kind: "cost_update",
          payload: { cost_usd: update.cost_usd ?? null, tokens_in: update.tokens_in ?? null, tokens_out: update.tokens_out ?? null },
        });
        if (update.result_text) {
          events.push({ kind: "text", payload: { text: update.result_text.slice(0, 2000), final: true } });
        }
        events.push({ kind: "turn_end", payload: { subtype: obj.subtype, is_error: obj.is_error ?? false, num_turns: obj.num_turns } });
        break;
      }
      default:
        events.push({ kind: "error", payload: { note: "unknown-native-event", raw: line.slice(0, 2000) } });
    }
    return { events, update };
  },
};

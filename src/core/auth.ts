import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig, McConfig } from "./config";
import type { HarnessAdapter } from "./adapters/types";
import { PreflightError, type CostBasis, type RunSpec } from "./types";

export interface ResolvedAuth {
  mode: RunSpec["auth"]["mode"];
  costBasis: CostBasis;
  gatewayCfg?: GatewayConfig;
  /** The one credential forwarded by name; value lives in memory only. */
  credential?: { envVar: string; value: string };
  /** Non-secret, for display/logging. */
  source: string;
}

function claudeSubscriptionCheck(): string | null {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return "CLAUDE_CODE_OAUTH_TOKEN (resident env)";
  if (process.platform === "darwin") {
    const probe = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
      stdio: "ignore",
    });
    if (probe.status === 0) return "macOS Keychain";
  }
  const credFile = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
  if (existsSync(credFile)) return credFile;
  return null;
}

function codexSubscriptionCheck(): string | null {
  const authFile = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  if (!existsSync(authFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(authFile, "utf8"));
    if (parsed?.tokens) return authFile; // ChatGPT login present (keys checked, values never read out)
  } catch {
    return null;
  }
  return null;
}

function piSubscriptionCheck(): string | null {
  const authFile = join(homedir(), ".pi", "agent", "auth.json");
  return existsSync(authFile) ? authFile : null;
}

/**
 * pi's DEFAULT provider/model selection depends on ambient env (observed live:
 * same command picked openrouter interactively and a broken openai-codex OAuth
 * under mc's stripped env). Subscription runs therefore require an explicit
 * provider-prefixed model whose provider actually has a stored credential slot.
 */
function piSubscriptionModelCheck(spec: RunSpec): void {
  if (!spec.model || !spec.model.includes("/")) {
    throw new PreflightError(
      `pi requires --model with a provider prefix (e.g. openai-codex/gpt-5.5): its default model selection depends on ambient env, which mc strips`,
    );
  }
  const provider = spec.model.split("/")[0]!;
  const authFile = join(homedir(), ".pi", "agent", "auth.json");
  try {
    const providers = Object.keys(JSON.parse(readFileSync(authFile, "utf8")));
    if (!providers.includes(provider)) {
      throw new PreflightError(
        `pi has no stored credential for provider "${provider}" (auth.json has: ${providers.join(", ") || "none"}); run \`pi\` interactively to add it, or use --gateway openrouter`,
      );
    }
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    throw new PreflightError(`could not read pi's auth.json to verify provider "${provider}"`);
  }
}

const SUBSCRIPTION_CHECKS: Record<string, { check: () => string | null; hint: string }> = {
  "claude-code": { check: claudeSubscriptionCheck, hint: "run `claude login` (or `claude setup-token` for headless) here first" },
  codex: { check: codexSubscriptionCheck, hint: "run `codex login` here first" },
  pi: { check: piSubscriptionCheck, hint: "run `pi` once interactively to store provider credentials in ~/.pi/agent/auth.json" },
};

const API_KEY_VARS: Record<string, string> = {
  "claude-code": "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
};

/** Cost basis is a property of (harness, auth mode), decided here, never inferred later. */
function costBasisFor(harness: string, mode: RunSpec["auth"]["mode"]): CostBasis {
  if (harness === "claude-code") {
    if (mode === "subscription") return "flat_subscription";
    if (mode === "api_key") return "metered_reported";
    return "unavailable"; // gateway: CLI's figure prices non-Anthropic tokens on Anthropic's table
  }
  if (harness === "codex") return "unavailable"; // exec --json never carries a dollar figure, any mode
  if (harness === "pi") return "metered_reported"; // pi computes real per-turn cost client-side, every mode
  return "unavailable";
}

export function resolveAuth(spec: RunSpec, adapter: HarnessAdapter, config: McConfig): ResolvedAuth {
  const mode = spec.auth.mode;

  if (!adapter.capabilities.auth_modes.includes(mode)) {
    const hint =
      adapter.name === "pi" && mode === "api_key"
        ? " (pi resolves credentials per provider from its own auth.json; CLI args leak via process listings - use subscription or --gateway)"
        : "";
    throw new PreflightError(`harness "${adapter.name}" does not support auth mode "${mode}"${hint}`);
  }

  const costBasis = costBasisFor(adapter.name, mode);
  // Adapter-specific refusal FIRST so the advice is correct: for claude-code no
  // auth mode can enforce a dollar cap (cost arrives only in the terminal result
  // event), so suggesting --api-key would just bounce the user to a second error.
  if (spec.budget_usd != null && adapter.name === "claude-code") {
    throw new PreflightError(
      `--budget cannot be enforced for claude-code (cost is reported only when the run ends); use --max-minutes instead`,
    );
  }
  if (spec.budget_usd != null && costBasis !== "metered_reported") {
    throw new PreflightError(
      `--budget has no meaning for ${adapter.name} under ${mode} auth (cost_basis: ${costBasis}). ` +
        `Drop --budget and use --max-minutes, or rerun with --api-key for a metered run.`,
    );
  }

  if (mode === "subscription") {
    const entry = SUBSCRIPTION_CHECKS[adapter.name];
    if (!entry) throw new PreflightError(`subscription check not implemented for harness "${adapter.name}"`);
    const source = entry.check();
    if (!source) {
      throw new PreflightError(
        `no resident ${adapter.name} login found on this host; ${entry.hint}. Credentials are never bridged from another machine.`,
      );
    }
    if (adapter.name === "pi") piSubscriptionModelCheck(spec);
    const credential =
      adapter.name === "claude-code" && process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: process.env.CLAUDE_CODE_OAUTH_TOKEN }
        : undefined;
    return { mode, costBasis, credential, source };
  }

  if (mode === "api_key") {
    const envVar = API_KEY_VARS[adapter.name];
    if (!envVar) throw new PreflightError(`api_key mode is not defined for harness "${adapter.name}"`);
    const value = process.env[envVar];
    if (!value) {
      throw new PreflightError(
        `--api-key requires ${envVar} to be set on this host; it is not. ` +
          `(Credentials are never bridged from elsewhere - export it here or use subscription/--gateway.)`,
      );
    }
    return { mode, costBasis, credential: { envVar, value }, source: `$${envVar}` };
  }

  // gateway
  const name = spec.auth.gateway;
  if (!name) throw new PreflightError(`--gateway requires a gateway name`);
  if (adapter.name === "pi" && name !== "openrouter") {
    throw new PreflightError(
      `pi gateway support is limited to "openrouter" in v0 (pi routes via its builtin openrouter provider; custom base URLs need pi-side provider config)`,
    );
  }
  const gatewayCfg = config.gateways[name];
  if (!gatewayCfg) {
    throw new PreflightError(
      `unknown gateway "${name}" (known: ${Object.keys(config.gateways).join(", ")}); add a [gateway.${name}] block to config.toml`,
    );
  }
  if (!spec.model || !spec.model.includes("/")) {
    throw new PreflightError(
      `--gateway requires a provider-prefixed model id (e.g. moonshotai/kimi-k3) - got "${spec.model ?? ""}"`,
    );
  }
  const value = process.env[gatewayCfg.env_var];
  if (!value) {
    throw new PreflightError(
      `gateway "${name}" requires ${gatewayCfg.env_var} to be set on this host; it is not. ` +
        `(Credentials are never bridged from elsewhere.)`,
    );
  }
  // claude-code's shim wiring authenticates via ANTHROPIC_AUTH_TOKEN.
  const envVar = adapter.name === "claude-code" ? "ANTHROPIC_AUTH_TOKEN" : gatewayCfg.env_var;
  return { mode, costBasis, gatewayCfg, credential: { envVar, value }, source: `$${gatewayCfg.env_var} via ${name}` };
}

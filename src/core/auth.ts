import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

/** Cost basis is a property of (harness, auth mode), decided here, never inferred later. */
function costBasisFor(harness: string, mode: RunSpec["auth"]["mode"]): CostBasis {
  if (harness === "claude-code") {
    if (mode === "subscription") return "flat_subscription";
    if (mode === "api_key") return "metered_reported";
    return "unavailable"; // gateway: CLI's figure prices non-Anthropic tokens on Anthropic's table
  }
  return "unavailable";
}

export function resolveAuth(spec: RunSpec, adapter: HarnessAdapter, config: McConfig): ResolvedAuth {
  const mode = spec.auth.mode;

  if (!adapter.capabilities.auth_modes.includes(mode)) {
    throw new PreflightError(`harness "${adapter.name}" does not support auth mode "${mode}"`);
  }

  const costBasis = costBasisFor(adapter.name, mode);
  if (spec.budget_usd != null && costBasis !== "metered_reported") {
    throw new PreflightError(
      `--budget has no meaning for ${adapter.name} under ${mode} auth (cost_basis: ${costBasis}). ` +
        `Drop --budget and use --max-minutes, or rerun with --api-key for a metered run.`,
    );
  }
  // Even metered claude-code reports cost only in the terminal result event, so
  // a dollar cap could never fire mid-run. Refuse loudly, never accepted-but-inert.
  if (spec.budget_usd != null && adapter.name === "claude-code") {
    throw new PreflightError(
      `--budget cannot be enforced for claude-code (cost is reported only when the run ends); use --max-minutes instead`,
    );
  }

  if (mode === "subscription") {
    if (adapter.name === "claude-code") {
      const source = claudeSubscriptionCheck();
      if (!source) {
        throw new PreflightError(
          `no Claude login found on this host; run \`claude login\` (or \`claude setup-token\` for headless) here first. Credentials are never bridged from another machine.`,
        );
      }
      const credential = process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: process.env.CLAUDE_CODE_OAUTH_TOKEN }
        : undefined;
      return { mode, costBasis, credential, source };
    }
    throw new PreflightError(`subscription check not implemented for harness "${adapter.name}"`);
  }

  if (mode === "api_key") {
    const envVar = adapter.name === "claude-code" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
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

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GatewayConfig {
  name: string;
  base_url_anthropic: string;
  base_url_openai: string;
  env_var: string;
  wire_api: "chat" | "responses";
}

export interface McConfig {
  notify: { exec: string | null; webhook: string | null };
  gateways: Record<string, GatewayConfig>;
}

const BUILTIN_GATEWAYS: Record<string, GatewayConfig> = {
  openrouter: {
    name: "openrouter",
    base_url_anthropic: "https://openrouter.ai/api",
    base_url_openai: "https://openrouter.ai/api/v1",
    env_var: "OPENROUTER_API_KEY",
    wire_api: "chat",
  },
};

export function mcHome(): string {
  return process.env.MC_HOME ?? join(homedir(), ".mission-control");
}

export function runsDir(): string {
  return join(mcHome(), "runs");
}

export function runDir(id: string): string {
  return join(runsDir(), id);
}

export function ensureHome(): void {
  mkdirSync(runsDir(), { recursive: true });
}

/**
 * Minimal TOML subset: [section] / [section.sub] headers, string / number /
 * boolean values, full-line comments. Enough for config.toml; no external dep.
 */
function parseToml(text: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let section = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([A-Za-z0-9_.\-]+)\]$/);
    if (header) {
      section = header[1]!;
      out[section] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_\-]+$/.test(key)) continue;
    let rhs = line.slice(eq + 1).trim();
    let value: unknown;
    if (rhs.startsWith('"')) {
      // Quote-aware: a '#' INSIDE the string is data, not a comment.
      const close = rhs.indexOf('"', 1);
      if (close < 0) continue; // malformed line; skip rather than truncate
      value = rhs.slice(1, close);
    } else {
      const hash = rhs.search(/\s#/);
      if (hash >= 0) rhs = rhs.slice(0, hash).trim();
      if (rhs === "true") value = true;
      else if (rhs === "false") value = false;
      else if (rhs !== "" && !Number.isNaN(Number(rhs))) value = Number(rhs);
      else value = rhs;
    }
    (out[section] ??= {})[key] = value;
  }
  return out;
}

export function loadConfig(): McConfig {
  const gateways: Record<string, GatewayConfig> = { ...BUILTIN_GATEWAYS };
  const config: McConfig = { notify: { exec: null, webhook: null }, gateways };

  const path = join(mcHome(), "config.toml");
  if (!existsSync(path)) return config;

  const sections = parseToml(readFileSync(path, "utf8"));
  for (const [name, values] of Object.entries(sections)) {
    if (name === "notify") {
      config.notify.exec = (values.exec as string) || null;
      config.notify.webhook = (values.webhook as string) || null;
    } else if (name.startsWith("gateway.")) {
      const gwName = name.slice("gateway.".length);
      const base = gateways[gwName];
      gateways[gwName] = {
        name: gwName,
        base_url_anthropic: (values.base_url_anthropic as string) ?? base?.base_url_anthropic ?? "",
        base_url_openai: (values.base_url_openai as string) ?? base?.base_url_openai ?? "",
        env_var: (values.env_var as string) ?? base?.env_var ?? "",
        wire_api: ((values.wire_api as string) ?? base?.wire_api ?? "chat") as "chat" | "responses",
      };
    }
  }
  return config;
}

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

export interface NotifyTarget {
  exec: string | null;
  webhook: string | null;
}

export interface McConfig {
  notify: NotifyTarget & {
    // A SEPARATE seam from the top-level exec/webhook above - deliberately
    // not folded into one hook. [notify] payloads assume a terminal RUN
    // shape (exit, cost_usd, ...); an assessment payload is shaped
    // differently (topic + run + assessment) and sending it through the
    // run hook could misfire an integration built against the run shape.
    // See notify.ts's notifyAssessment and docs/agents.md.
    assessment: NotifyTarget;
  };
  gateways: Record<string, GatewayConfig>;
}

const BUILTIN_GATEWAYS: Record<string, GatewayConfig> = {
  openrouter: {
    name: "openrouter",
    base_url_anthropic: "https://openrouter.ai/api",
    base_url_openai: "https://openrouter.ai/api/v1",
    env_var: "OPENROUTER_API_KEY",
    // codex >= 0.145 dropped wire_api="chat" support entirely ("no longer
    // supported... set wire_api = \"responses\""); OpenRouter serves both
    // /v1/chat/completions and /v1/responses, confirmed live via
    // `mc harness check codex --gateway openrouter`.
    wire_api: "responses",
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

// Real TOML basic-string escapes we round-trip. Anything else after a
// backslash is left as-is (both chars kept literally) - lenient, not a full
// TOML implementation, but this keeps decode a strict inverse of encode
// (quoteTomlString below) for every value THIS codebase ever writes.
const TOML_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r" };

/**
 * Parse a double-quoted TOML value starting at rhs[0] === '"'. Escape-aware:
 * `\"` and `\\` (and a few common escapes) are unescaped rather than treated
 * as the string's end or left as literal backslash-quote pairs - a value
 * containing either character (an exec command like `cat > "a file.json"`,
 * or any path/URL with a backslash) previously broke both the write side
 * (raw interpolation produced invalid TOML) and, had it somehow been written
 * with a literal unescaped quote, the read side too (the old scanner stopped
 * at the FIRST quote it saw, silently truncating everything after it).
 * Returns null for a genuinely malformed line (no closing quote at all) -
 * still skipped rather than guessed at, same as before.
 */
function parseQuotedString(rhs: string): string | null {
  let out = "";
  let i = 1;
  while (i < rhs.length) {
    const ch = rhs[i]!;
    if (ch === '"') return out;
    if (ch === "\\" && i + 1 < rhs.length) {
      const escaped = TOML_ESCAPES[rhs[i + 1]!];
      if (escaped !== undefined) {
        out += escaped;
        i += 2;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return null; // no closing quote found - malformed; skip rather than truncate
}

/**
 * The write-side inverse of parseQuotedString above: escapes backslash and
 * double-quote (order matters - backslashes first, or a quote's own escaping
 * backslash would itself get re-escaped) so any value - an exec command
 * containing embedded quotes, a URL, anything - round-trips through
 * config.toml exactly, instead of producing invalid TOML that silently stops
 * being read past the first raw quote.
 */
export function quoteTomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
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
      // Quote-aware AND escape-aware: a '#' inside the string is data, not a
      // comment, and an escaped '"' or '\\' doesn't end the string early.
      const parsed = parseQuotedString(rhs);
      if (parsed === null) continue; // malformed line; skip rather than truncate
      value = parsed;
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

/**
 * Diagnostic for `mc init --check`: which raw lines under a `[section]`
 * header look like a key=value assignment but the parser above could NOT
 * actually extract a value from (today: only an unterminated quoted string -
 * the one failure mode that silently drops a key rather than rejecting the
 * whole file). loadConfig()/parseToml() are deliberately lenient - a
 * malformed line is skipped, not fatal, so config.toml as a whole keeps
 * working - but that leniency means a hook that failed to parse looks
 * IDENTICAL to "nothing configured" from loadConfig()'s output alone. This
 * lets `mc init --check` tell the two apart and report the real one as
 * broken instead of passing it silently.
 */
export function malformedLines(text: string, section: string): string[] {
  const lines = text.split("\n");
  const headerRe = new RegExp(`^\\[${section.replace(/\./g, "\\.")}\\]$`);
  const anyHeaderRe = /^\[[A-Za-z0-9_.\-]+\]$/;
  const start = lines.findIndex((l) => headerRe.test(l.trim()));
  if (start === -1) return [];
  const bad: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (anyHeaderRe.test(line)) break;
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_\-]+$/.test(key)) continue;
    const rhs = line.slice(eq + 1).trim();
    if (rhs.startsWith('"') && parseQuotedString(rhs) === null) bad.push(line);
  }
  return bad;
}

export function loadConfig(): McConfig {
  const gateways: Record<string, GatewayConfig> = { ...BUILTIN_GATEWAYS };
  const config: McConfig = {
    notify: { exec: null, webhook: null, assessment: { exec: null, webhook: null } },
    gateways,
  };

  const path = join(mcHome(), "config.toml");
  if (!existsSync(path)) return config;

  const sections = parseToml(readFileSync(path, "utf8"));
  for (const [name, values] of Object.entries(sections)) {
    if (name === "notify") {
      config.notify.exec = (values.exec as string) || null;
      config.notify.webhook = (values.webhook as string) || null;
    } else if (name === "notify.assessment") {
      config.notify.assessment.exec = (values.exec as string) || null;
      config.notify.assessment.webhook = (values.webhook as string) || null;
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

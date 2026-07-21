import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getAdapter } from "./adapters/registry";
import type { LaunchContext } from "./adapters/types";
import { resolveAuth } from "./auth";
import { loadConfig, runDir } from "./config";
import { getRun, insertEvent, updateRun } from "./db";
import { notifyTerminal } from "./notify";
import type { Run, RunSpec } from "./types";
import { verify } from "./verify";

/** Child env is built additively from empty - never inherited (SPEC: Auth & billing). */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "TERM"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

/**
 * Watch one run to termination: tail events, enforce caps, verify, notify, exit.
 * Runs as a detached process; everything it learns lands in SQLite, not stdout.
 */
export async function supervise(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const dir = runDir(runId);
  const stored = JSON.parse(readFileSync(run.spec_path, "utf8"));
  const spec = stored as RunSpec;
  const isGit: boolean = stored.is_git;
  const binPath: string = stored.bin;

  const adapter = getAdapter(spec.harness);
  const config = loadConfig();
  // Re-resolved fresh, same host, never persisted (SPEC: auth preflight).
  const auth = resolveAuth(spec, adapter, config);

  const ctx: LaunchContext = {
    spec,
    binPath,
    gatewayCfg: auth.gatewayCfg,
    credential: auth.credential,
    workdir: run.workdir,
  };
  const { argv, env } = adapter.buildCommand(ctx);

  // Vendor CLIs can echo auth material on a 401; scrub the values we injected
  // from everything we persist (SPEC: auth security invariants). Degenerate
  // short values are skipped - replacing them would shred ordinary text.
  const secrets = auth.credential ? [auth.credential.value].filter((s) => s.length >= 8) : [];
  const scrub = (s: string): string => {
    let out = s;
    for (const secret of secrets) out = out.replaceAll(secret, "***");
    return out;
  };

  const stdoutFile = createWriteStream(join(dir, "stdout.jsonl"), { flags: "a" });
  const stderrFile = createWriteStream(run.stderr_path, { flags: "a" });

  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: run.workdir,
    env: { ...baseEnv(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  updateRun(runId, { exit: "running", pid: child.pid ?? null, supervisor_pid: process.pid });
  insertEvent(runId, "status_change", { exit: "running", pid: child.pid, supervisor_pid: process.pid });

  let killedByCap: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (run.max_minutes) {
    timer = setTimeout(() => {
      killedByCap = `max_minutes (${run.max_minutes}) exceeded`;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref?.();
    }, run.max_minutes * 60_000);
  }

  // Parser health: blindness (unparsed lines, or never seeing a terminal result
  // event) must cap the verdict at unverifiable, not pass silently.
  let parseErrors = 0;
  let sawResult = false;

  const updates: Record<string, unknown> = {};
  const stdoutLines = createInterface({ input: child.stdout! });
  stdoutLines.on("line", (line) => {
    const clean = scrub(line);
    stdoutFile.write(clean + "\n");
    const mapped = adapter.mapLine(clean);
    for (const event of mapped.events) {
      if (event.kind === "error") parseErrors++;
      if (event.kind === "turn_end") sawResult = true;
      insertEvent(runId, event.kind, event.payload);
    }
    if (mapped.update) {
      const { session_ref, cost_usd, tokens_in, tokens_out } = mapped.update;
      if (session_ref) updates.session_ref = session_ref;
      // cost_usd is copied onto the run ONLY when the basis says the figure is
      // real; gateway-mode figures stay in the event stream for debugging.
      if (cost_usd != null && run.cost_basis === "metered_reported") updates.cost_usd = cost_usd;
      if (tokens_in != null) updates.tokens_in = tokens_in;
      if (tokens_out != null) updates.tokens_out = tokens_out;
      if (Object.keys(updates).length > 0) updateRun(runId, updates as never);
      // Budget is enforceable only when the harness reports cost (cost_basis
      // gating already refused --budget everywhere else at preflight).
      if (run.budget_usd != null && cost_usd != null && cost_usd > run.budget_usd) {
        killedByCap = `budget ($${run.budget_usd}) exceeded at $${cost_usd}`;
        child.kill("SIGTERM");
      }
    }
  });

  const stderrLines = createInterface({ input: child.stderr! });
  stderrLines.on("line", (line) => stderrFile.write(scrub(line) + "\n"));

  const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: string | null }>(
    (resolveWait) => {
      child.on("close", (code, sig) => resolveWait({ exitCode: code, signal: sig }));
      child.on("error", (error) => {
        insertEvent(runId, "error", { note: "spawn-failed", message: String(error) });
        resolveWait({ exitCode: null, signal: null });
      });
    },
  );
  if (timer) clearTimeout(timer);
  stdoutFile.end();
  stderrFile.end();

  // Classification: a run is `killed` only once the process actually died from
  // a signal (cap or `mc kill`); the CLI never pre-marks terminal state.
  const current = getRun(runId)!;
  let exit: Run["exit"];
  if (killedByCap || signal != null) exit = "killed";
  else if (exitCode === 0) exit = "succeeded";
  else exit = "failed";
  if (killedByCap) insertEvent(runId, "error", { note: "cap-exceeded", detail: killedByCap });

  const parserHealthy = parseErrors === 0 && sawResult;
  const verification = verify({ ...current, exit } as Run, spec, exitCode, isGit, parserHealthy);
  insertEvent(runId, "verify_result", { verdict: verification.verdict, checks: JSON.parse(verification.evidence) });

  updateRun(runId, {
    exit,
    verdict: verification.verdict,
    ended_at: new Date().toISOString(),
    verify_evidence: verification.evidence,
  });
  insertEvent(runId, "exited", { exit, exit_code: exitCode, verdict: verification.verdict });

  await notifyTerminal(getRun(runId)!, config);
}

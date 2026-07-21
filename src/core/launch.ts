import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAdapter } from "./adapters/registry";
import { resolveAuth } from "./auth";
import { loadConfig, runDir } from "./config";
import { getRun, insertEvent, insertRun } from "./db";
import { PreflightError, type Run, type RunSpec } from "./types";
import { artifactStaysInside } from "./verify";
import { createWorkdir } from "./workspace";

function newRunId(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = randomBytes(3).toString("hex");
    if (!getRun(id)) return id;
  }
  throw new Error("could not allocate a run id");
}

function deriveTitle(goal: string): string {
  const line = goal.split("\n")[0]!.trim();
  return line.length <= 60 ? line : line.slice(0, 57) + "...";
}

function assertPositive(name: string, value: number | null): void {
  if (value != null && (!Number.isFinite(value) || value <= 0)) {
    throw new PreflightError(`${name} must be a finite positive number, got "${value}"`);
  }
}

export function launch(spec: RunSpec): Run {
  const adapter = getAdapter(spec.harness);
  const config = loadConfig();

  // Fail-closed preflight: caps, artifacts, auth (incl. budget enforceability), binary.
  assertPositive("--budget", spec.budget_usd);
  assertPositive("--max-minutes", spec.max_minutes);
  for (const artifact of spec.artifacts) {
    if (!artifactStaysInside(artifact)) {
      throw new PreflightError(
        `artifact path "${artifact}" is absolute or escapes the run workdir; declare workdir-relative paths only`,
      );
    }
  }
  const auth = resolveAuth(spec, adapter, config);
  const detection = adapter.detect();
  if (!detection.installed || !detection.path) {
    throw new PreflightError(`harness CLI for "${adapter.name}" not found on this host`);
  }

  const id = newRunId();
  const { workdir, isGit } = createWorkdir(id, spec.cwd);
  const dir = runDir(id);
  const specPath = join(dir, "spec.json");
  writeFileSync(specPath, JSON.stringify({ ...spec, is_git: isGit, bin: detection.path }, null, 2));

  const run: Run = {
    id,
    parent_run_id: null,
    root_run_id: id,
    harness: spec.harness,
    model: spec.model,
    host: hostname(),
    goal: spec.goal,
    title: deriveTitle(spec.goal),
    spec_path: specPath,
    workdir,
    session_ref: null,
    exit: "queued",
    verdict: "pending",
    started_at: new Date().toISOString(),
    ended_at: null,
    cost_usd: null,
    cost_basis: auth.costBasis,
    tokens_in: null,
    tokens_out: null,
    budget_usd: spec.budget_usd,
    max_minutes: spec.max_minutes,
    auth_mode: auth.mode,
    gateway: spec.auth.gateway ?? null,
    pid: null,
    supervisor_pid: null,
    stderr_path: join(dir, "stderr.log"),
    artifacts: spec.artifacts,
    verify_evidence: null,
    notified: false,
  };
  insertRun(run);
  insertEvent(id, "status_change", { exit: "queued", auth_mode: auth.mode, auth_source: auth.source });

  // Detached per-run supervisor: its lifetime equals the run's; mc exits now.
  // The run id travels via MC_SUPERVISE (not argv) so the same invocation works
  // from source, `bun build` bundles, and compiled binaries.
  const sibling = fileURLToPath(new URL("../mc.ts", import.meta.url));
  const argv1 = process.argv[1];
  const entryArgs = existsSync(sibling)
    ? [sibling] // running from source (incl. tests importing core directly)
    : argv1 && /\.(m?js|ts)$/.test(argv1) && existsSync(argv1)
      ? [argv1] // bundled mc.js
      : []; // compiled binary: execPath IS mc
  const child = spawn(process.execPath, entryArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MC_SUPERVISE: id },
  });
  child.unref();

  return run;
}

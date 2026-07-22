import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAdapter } from "./adapters/registry";
import { resolveAuth } from "./auth";
import { loadConfig, runDir } from "./config";
import { getRun, insertEvent, insertRun, updateRun } from "./db";
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

function deriveTitle(prompt: string): string {
  const line = prompt.split("\n")[0]!.trim();
  return line.length <= 60 ? line : line.slice(0, 57) + "...";
}

function assertPositive(name: string, value: number | null): void {
  if (value != null && (!Number.isFinite(value) || value <= 0)) {
    throw new PreflightError(`${name} must be a finite positive number, got "${value}"`);
  }
}

export interface LaunchOptions {
  /** mc resume: continue the parent's harness session in the parent's workdir. */
  parent?: Run;
}

export function launch(spec: RunSpec, options: LaunchOptions = {}): Run {
  const adapter = getAdapter(spec.harness);
  const config = loadConfig();
  const parent = options.parent ?? null;

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
  if (parent) {
    if (adapter.capabilities.resume !== "native") {
      throw new PreflightError(
        `harness "${adapter.name}" declares resume: "${adapter.capabilities.resume}" - it cannot continue a session (never silently starts fresh)`,
      );
    }
    if (!parent.session_id) {
      throw new PreflightError(
        `run ${parent.id} has no session reference to resume (its stream never yielded one - see mc show ${parent.id})`,
      );
    }
    if (parent.harness !== spec.harness) {
      throw new PreflightError(`cannot resume a ${parent.harness} run with harness ${spec.harness}`);
    }
  }
  const auth = resolveAuth(spec, adapter, config);
  const detection = adapter.detect();
  if (!detection.installed || !detection.path) {
    throw new PreflightError(
      detection.path
        ? `harness CLI for "${adapter.name}" at ${detection.path} failed its --version probe (stale path? not executable?)`
        : `harness CLI for "${adapter.name}" not found on this host`,
    );
  }

  const id = newRunId();
  const title = deriveTitle(spec.prompt); // before any disk effects: a bad prompt must not orphan a workdir
  // Resume continues in the PARENT's workdir: same worktree, same artifacts,
  // same harness-native session store next to it.
  let workdir: string;
  let isGit: boolean;
  if (parent) {
    const parentStored = JSON.parse(readFileSync(parent.spec_path, "utf8"));
    workdir = parent.workdir;
    isGit = Boolean(parentStored.is_git);
  } else {
    ({ workdir, isGit } = createWorkdir(id, spec.cwd));
  }
  const dir = runDir(id);
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, "spec.json");
  writeFileSync(
    specPath,
    JSON.stringify(
      { ...spec, is_git: isGit, bin: detection.path, resume_session_id: parent?.session_id ?? undefined },
      null,
      2,
    ),
  );

  const run: Run = {
    id,
    parent_run_id: parent?.id ?? null,
    root_run_id: parent?.root_run_id ?? id,
    harness: spec.harness,
    model: spec.model,
    host: hostname(),
    prompt: spec.prompt,
    title,
    spec_path: specPath,
    workdir,
    session_id: null,
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
  // Record the watcher pid on the still-queued row so reap can detect a
  // supervisor that dies before it ever reaches `running`.
  if (child.pid) updateRun(id, { supervisor_pid: child.pid });

  return run;
}

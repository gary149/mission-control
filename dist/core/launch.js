import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAdapter } from "./adapters/registry.js";
import { resolveAuth } from "./auth.js";
import { loadConfig, runDir } from "./config.js";
import { getRun, insertEvent, insertRun, updateRun } from "./db.js";
import { PreflightError } from "./types.js";
import { artifactStaysInside } from "./verify.js";
import { createWorkdir, createWorkdirFromCheckpoint } from "./workspace.js";
function newRunId() {
    for (let attempt = 0; attempt < 10; attempt++) {
        const id = randomBytes(3).toString("hex");
        if (!getRun(id))
            return id;
    }
    throw new Error("could not allocate a run id");
}
function deriveTitle(prompt) {
    const line = prompt.split("\n")[0].trim();
    return line.length <= 60 ? line : line.slice(0, 57) + "...";
}
function assertPositive(name, value) {
    if (value != null && (!Number.isFinite(value) || value <= 0)) {
        throw new PreflightError(`${name} must be a finite positive number, got "${value}"`);
    }
}
export function launch(spec, options = {}) {
    const adapter = getAdapter(spec.harness);
    const config = loadConfig();
    const parent = options.parent ?? null;
    // Fail-closed preflight: caps, artifacts, auth (incl. budget enforceability), binary.
    assertPositive("--budget", spec.budget_usd);
    assertPositive("--max-minutes", spec.max_minutes);
    // Idle cap allows 0 (explicit disable) but nothing negative or non-finite.
    if (spec.max_idle_minutes != null && (!Number.isFinite(spec.max_idle_minutes) || spec.max_idle_minutes < 0)) {
        throw new PreflightError(`--max-idle-minutes must be a finite number >= 0 (0 disables stall detection)`);
    }
    for (const artifact of spec.artifacts) {
        if (!artifactStaysInside(artifact)) {
            throw new PreflightError(`artifact path "${artifact}" is absolute or escapes the run workdir; declare workdir-relative paths only`);
        }
    }
    if (parent) {
        if (parent.harness !== spec.harness) {
            throw new PreflightError(`cannot resume a ${parent.harness} run with harness ${spec.harness}`);
        }
        // --fresh starts a NEW session by design, so it needs neither native
        // resume capability nor a captured session id.
        if (!options.fresh) {
            if (adapter.capabilities.resume !== "native") {
                throw new PreflightError(`harness "${adapter.name}" declares resume: "${adapter.capabilities.resume}" - it cannot continue a session (never silently starts fresh)`);
            }
            if (!parent.session_id) {
                throw new PreflightError(`run ${parent.id} has no session reference to resume (its stream never yielded one - see mc show ${parent.id})`);
            }
        }
    }
    const auth = resolveAuth(spec, adapter, config);
    const detection = adapter.detect();
    if (!detection.installed || !detection.path) {
        throw new PreflightError(detection.path
            ? `harness CLI for "${adapter.name}" at ${detection.path} failed its --version probe (stale path? not executable?)`
            : `harness CLI for "${adapter.name}" not found on this host`);
    }
    const id = newRunId();
    const title = deriveTitle(spec.prompt); // before any disk effects: a bad prompt must not orphan a workdir
    // Native resume continues in the PARENT's workdir: same worktree, same
    // artifacts, same harness-native session store next to it. A --fresh
    // restart instead gets a NEW worktree at the checkpoint commit.
    let workdir;
    let isGit;
    let checkpoint;
    if (parent) {
        const parentStored = JSON.parse(readFileSync(parent.spec_path, "utf8"));
        if (options.fresh) {
            if (!parentStored.is_git) {
                throw new PreflightError(`run ${parent.id} has no git workdir; --fresh restarts continue from a checkpoint commit (nothing to restart from in a plain directory)`);
            }
            ({ workdir, checkpoint } = createWorkdirFromCheckpoint(id, parent.workdir, options.at ?? null));
            isGit = true;
        }
        else {
            workdir = parent.workdir;
            isGit = Boolean(parentStored.is_git);
        }
    }
    else {
        ({ workdir, isGit } = createWorkdir(id, spec.cwd));
    }
    // HEAD at launch anchors the commit-aware git_effect check: work an agent
    // COMMITS (leaving a clean tree) must still count as an effect.
    let gitHeadAtLaunch = null;
    if (isGit) {
        const head = spawnSync("git", ["-C", workdir, "rev-parse", "HEAD"], { encoding: "utf8" });
        gitHeadAtLaunch = head.status === 0 ? head.stdout.trim() : null; // null: unborn branch, porcelain-only
    }
    const dir = runDir(id);
    mkdirSync(dir, { recursive: true });
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, JSON.stringify({
        ...spec,
        is_git: isGit,
        bin: detection.path,
        resume_session_id: options.fresh ? undefined : (parent?.session_id ?? undefined),
        checkpoint,
        git_head_at_launch: gitHeadAtLaunch ?? undefined,
    }, null, 2));
    const run = {
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
        // Stall detection defaults ON: fleet data shows healthy runs never exceed
        // ~12m of stream silence while real stalls sit at 75-128m (run b758fe
        // class). 30m is 2.5x the observed healthy ceiling. 0 disables.
        max_idle_minutes: spec.max_idle_minutes ?? 30,
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
    // from the shipped dist (mc.js) and from source / tests (mc.ts, node type
    // stripping). Resolved as a sibling of THIS module, never from argv[1]: under
    // `node --test` argv[1] is the test file and spawning it would rerun the suite.
    const entry = ["../mc.js", "../mc.ts"]
        .map((p) => fileURLToPath(new URL(p, import.meta.url)))
        .find(existsSync);
    if (!entry)
        throw new Error("cannot locate the mc entrypoint next to this module");
    const child = spawn(process.execPath, [entry], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, MC_SUPERVISE: id },
    });
    child.unref();
    // Record the watcher pid on the still-queued row so reap can detect a
    // supervisor that dies before it ever reaches `running`.
    if (child.pid)
        updateRun(id, { supervisor_pid: child.pid });
    return run;
}

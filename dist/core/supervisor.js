import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getAdapter } from "./adapters/registry.js";
import { resolveAuth } from "./auth.js";
import { loadConfig, runDir } from "./config.js";
import { eventsAfter, getRun, insertEvent, updateRun } from "./db.js";
import { notifyTerminal } from "./notify.js";
/** Child env is built additively from empty - never inherited (SPEC: Auth & billing). */
function baseEnv() {
    const env = {};
    for (const key of ["PATH", "HOME", "LANG", "TERM"]) {
        if (process.env[key])
            env[key] = process.env[key];
    }
    return env;
}
/**
 * Signal the child's whole process GROUP, not just the harness pid. The child
 * is spawned `detached: true`, which makes it a process-group leader, so
 * `-pid` reaches every descendant it spawned (dev servers, tool subprocesses)
 * that a bare `child.kill()` would otherwise orphan on every cap-kill. The
 * group can already be gone (child exited between our check and the signal,
 * or this platform has no group semantics for it) - that is not an error.
 */
function killGroup(child, signal) {
    const pid = child.pid;
    if (!pid)
        return;
    try {
        process.kill(-pid, signal);
    }
    catch {
        /* group already gone */
    }
}
/**
 * The harness pid's process start time, captured once right here at spawn.
 * `ps -o lstart=` is a fixed-width, per-process-instance timestamp available
 * on both darwin and linux with no extra dependencies - it's what `mc kill`
 * later compares against (see cli.ts's matching `pidStart`) before trusting
 * that a `lost` run's recorded pid still refers to THIS run's harness and
 * not an unrelated process, or a different concurrent run of the same
 * harness binary, that has since reused the same pid number.
 */
function pidStart(pid) {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    const out = result.stdout.trim();
    return out || null;
}
/**
 * Watch one run to termination: tail events, enforce caps, verify, notify, exit.
 * Runs as a detached process; everything it learns lands in SQLite, not stdout.
 */
export async function supervise(runId) {
    const run = getRun(runId);
    if (!run)
        throw new Error(`unknown run ${runId}`);
    const dir = runDir(runId);
    const stored = JSON.parse(readFileSync(run.spec_path, "utf8"));
    const spec = stored;
    const binPath = stored.bin;
    const adapter = getAdapter(spec.harness);
    const config = loadConfig();
    // Re-resolved fresh, same host, never persisted (SPEC: auth preflight).
    const auth = resolveAuth(spec, adapter, config);
    const ctx = {
        spec,
        binPath,
        gatewayCfg: auth.gatewayCfg,
        credential: auth.credential,
        workdir: run.workdir,
        resumeSessionId: typeof stored.resume_session_id === "string" ? stored.resume_session_id : undefined,
    };
    const { argv, env } = adapter.buildCommand(ctx);
    // Vendor CLIs can echo auth material on a 401; scrub the values we injected
    // from everything we persist (SPEC: auth security invariants). Degenerate
    // short values are skipped - replacing them would shred ordinary text.
    const secrets = auth.credential ? [auth.credential.value].filter((s) => s.length >= 8) : [];
    const scrub = (s) => {
        let out = s;
        for (const secret of secrets)
            out = out.replaceAll(secret, "***");
        return out;
    };
    const stdoutFile = createWriteStream(join(dir, "stdout.jsonl"), { flags: "a" });
    const stderrFile = createWriteStream(run.stderr_path, { flags: "a" });
    const child = spawn(argv[0], argv.slice(1), {
        cwd: run.workdir,
        env: { ...baseEnv(), ...env },
        stdio: ["ignore", "pipe", "pipe"],
        // Process-group leader: a harness's own descendants (dev servers, tool
        // subprocesses) must die with it on every kill path (SPEC: Supervisor).
        detached: true,
    });
    updateRun(runId, { exit: "running", pid: child.pid ?? null, supervisor_pid: process.pid });
    insertEvent(runId, "status_change", {
        exit: "running",
        pid: child.pid,
        supervisor_pid: process.pid,
        // Recorded once, here, at the moment this pid is uniquely THIS
        // process (see pidStart above) - the identity anchor `mc kill` needs
        // once the run goes `lost` and nobody's watching it anymore.
        pid_start: child.pid ? pidStart(child.pid) : null,
    });
    let killedByCap = null;
    let timer = null;
    if (run.max_minutes) {
        timer = setTimeout(() => {
            killedByCap = `max_minutes (${run.max_minutes}) exceeded`;
            killGroup(child, "SIGTERM");
            setTimeout(() => killGroup(child, "SIGKILL"), 10_000).unref?.();
        }, run.max_minutes * 60_000);
    }
    // Stall detection: raw stream lines (stdout OR stderr) are the activity
    // signal, NOT inserted events - adapters skip benign native noise without
    // inserting anything, so event gaps overstate silence (a retry storm is
    // alive). Fleet data: healthy runs never exceed ~12m of stream silence;
    // real stalls (the b758fe live-locked Agent dispatch class) sit at 75-128m.
    // SIGKILL escalation is required: a live-locked event loop ignores SIGTERM.
    let lastActivity = Date.now();
    let idleTimer = null;
    const idleMs = (run.max_idle_minutes ?? 0) * 60_000;
    if (idleMs > 0) {
        idleTimer = setInterval(() => {
            if (killedByCap)
                return;
            if (Date.now() - lastActivity > idleMs) {
                killedByCap = `max_idle_minutes (${run.max_idle_minutes}) exceeded: no harness output since ${new Date(lastActivity).toISOString()}`;
                killGroup(child, "SIGTERM");
                setTimeout(() => killGroup(child, "SIGKILL"), 10_000).unref?.();
            }
        }, Math.max(1000, Math.min(30_000, idleMs / 4)));
    }
    let sawHarnessError = false;
    // Authoritative terminal outcome: some harnesses (pi, confirmed) exit the
    // process with code 0 even when the FINAL turn errored or aborted - process
    // exit code alone is not the truth. Adapters carry that signal on turn_end's
    // is_error; only the MOST RECENT turn_end is authoritative (earlier turns in
    // a multi-turn run can error and still recover). Deliberately narrower than
    // sawHarnessError: codex emits harness-error for benign, recoverable
    // item-level diagnostics on runs that legitimately succeed, so that signal
    // must never gate classification.
    let lastTurnError = false;
    const stderrTail = [];
    // Delta-reporting harnesses (pi, codex) emit per-turn figures; accumulate.
    let costAccumulated = null;
    let tokensInAccumulated = null;
    let tokensOutAccumulated = null;
    const updates = {};
    const stdoutLines = createInterface({ input: child.stdout });
    stdoutLines.on("line", (line) => {
        const clean = scrub(line);
        stdoutFile.write(clean + "\n");
        lastActivity = Date.now();
        const mapped = adapter.mapLine(clean);
        for (const event of mapped.events) {
            const note = event.payload?.note;
            if (event.kind === "error" && note === "harness-error")
                sawHarnessError = true;
            if (event.kind === "turn_end") {
                lastTurnError = event.payload?.is_error === true;
            }
            insertEvent(runId, event.kind, event.payload);
        }
        if (mapped.update) {
            const u = mapped.update;
            if (u.session_id)
                updates.session_id = u.session_id;
            // cost lands on the run ONLY when the basis says the figure is real;
            // gateway-mode claude figures stay in the event stream for debugging.
            const metered = run.cost_basis === "metered_reported";
            if (u.cost_usd != null && metered)
                updates.cost_usd = u.cost_usd;
            if (u.cost_usd_delta != null && metered) {
                costAccumulated = (costAccumulated ?? 0) + u.cost_usd_delta;
                updates.cost_usd = costAccumulated;
            }
            if (u.tokens_in != null)
                updates.tokens_in = u.tokens_in;
            if (u.tokens_out != null)
                updates.tokens_out = u.tokens_out;
            if (u.tokens_in_delta != null) {
                tokensInAccumulated = (tokensInAccumulated ?? 0) + u.tokens_in_delta;
                updates.tokens_in = tokensInAccumulated;
            }
            if (u.tokens_out_delta != null) {
                tokensOutAccumulated = (tokensOutAccumulated ?? 0) + u.tokens_out_delta;
                updates.tokens_out = tokensOutAccumulated;
            }
            if (Object.keys(updates).length > 0)
                updateRun(runId, updates);
            // Budget enforcement: real for per-turn cost reporters (pi) - the run is
            // killed between turns the moment the accumulated spend crosses the cap.
            const currentCost = updates.cost_usd ?? null;
            if (run.budget_usd != null && currentCost != null && currentCost > run.budget_usd) {
                killedByCap = `budget ($${run.budget_usd}) exceeded at $${currentCost.toFixed(4)}`;
                killGroup(child, "SIGTERM");
            }
        }
    });
    const stderrLines = createInterface({ input: child.stderr });
    stderrLines.on("line", (line) => {
        const clean = scrub(line);
        stderrFile.write(clean + "\n");
        lastActivity = Date.now();
        stderrTail.push(clean);
        if (stderrTail.length > 10)
            stderrTail.shift();
    });
    const { exitCode, signal } = await new Promise((resolveWait) => {
        child.on("close", (code, sig) => resolveWait({ exitCode: code, signal: sig }));
        child.on("error", (error) => {
            insertEvent(runId, "error", { note: "spawn-failed", message: String(error) });
            resolveWait({ exitCode: null, signal: null });
        });
    });
    if (timer)
        clearTimeout(timer);
    if (idleTimer)
        clearInterval(idleTimer);
    stdoutFile.end();
    stderrFile.end();
    // Classification: a run is `killed` only once the process actually died from
    // a signal (cap or `mc kill`); the CLI never pre-marks terminal state.
    // `mc kill` runs in a separate CLI process: it writes a kill_requested
    // status_change event and sends SIGTERM, but the run stays `running` until
    // THIS process observes the child actually exit. A harness that traps
    // SIGTERM and exits 0 anyway must still be classified `killed` - the user
    // asked it to stop, so a clean exit afterward is not a success. Re-read via
    // eventsAfter (not a local flag) because the event was written by that
    // other process, not this one.
    const killWasRequested = eventsAfter(runId, 0).some((e) => e.kind === "status_change" && e.payload?.kill_requested === true);
    let exit;
    if (killedByCap || signal != null || killWasRequested)
        exit = "killed";
    // exitCode === 0 is necessary but not sufficient: a harness that reports a
    // failed/aborted final turn but exits the process clean (pi's print-mode
    // JSON path, confirmed live) must not land here as a false green.
    else if (exitCode === 0 && !lastTurnError)
        exit = "succeeded";
    else
        exit = "failed";
    if (killedByCap)
        insertEvent(runId, "error", { note: "cap-exceeded", detail: killedByCap });
    // A harness that dies with no harness-reported error on stdout (kimi-code's
    // probed failure mode) would otherwise leave its reason ONLY in stderr.log -
    // invisible to mc tail/show and the notify payload. Synthesize the reason
    // into the stream.
    if (exit !== "succeeded" && !sawHarnessError && stderrTail.length > 0) {
        insertEvent(runId, "error", { note: "stderr-tail", excerpt: stderrTail.join("\n").slice(-1000) });
    }
    updateRun(runId, { exit, ended_at: new Date().toISOString() });
    insertEvent(runId, "exited", { exit, exit_code: exitCode });
    await notifyTerminal(getRun(runId), config);
}

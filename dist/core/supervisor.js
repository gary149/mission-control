import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getAdapter } from "./adapters/registry.js";
import { resolveAuth } from "./auth.js";
import { loadConfig, runDir } from "./config.js";
import { getRun, insertEvent, updateRun } from "./db.js";
import { notifyTerminal } from "./notify.js";
import { verify } from "./verify.js";
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
    const isGit = stored.is_git;
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
    });
    updateRun(runId, { exit: "running", pid: child.pid ?? null, supervisor_pid: process.pid });
    insertEvent(runId, "status_change", { exit: "running", pid: child.pid, supervisor_pid: process.pid });
    let killedByCap = null;
    let timer = null;
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
    // Delta-reporting harnesses (pi, codex) emit per-turn figures; accumulate.
    let costAccumulated = null;
    let tokensInAccumulated = null;
    let tokensOutAccumulated = null;
    const updates = {};
    const stdoutLines = createInterface({ input: child.stdout });
    stdoutLines.on("line", (line) => {
        const clean = scrub(line);
        stdoutFile.write(clean + "\n");
        const mapped = adapter.mapLine(clean);
        for (const event of mapped.events) {
            // Parser health tracks BLINDNESS (lines mc could not read), never
            // harness-reported errors - a cleanly parsed failure is still a parse.
            const note = event.payload?.note;
            if (event.kind === "error" && (note === "unparsed" || note === "unknown-native-event"))
                parseErrors++;
            if (event.kind === "turn_end")
                sawResult = true;
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
                child.kill("SIGTERM");
            }
        }
    });
    const stderrLines = createInterface({ input: child.stderr });
    stderrLines.on("line", (line) => stderrFile.write(scrub(line) + "\n"));
    const { exitCode, signal } = await new Promise((resolveWait) => {
        child.on("close", (code, sig) => resolveWait({ exitCode: code, signal: sig }));
        child.on("error", (error) => {
            insertEvent(runId, "error", { note: "spawn-failed", message: String(error) });
            resolveWait({ exitCode: null, signal: null });
        });
    });
    if (timer)
        clearTimeout(timer);
    stdoutFile.end();
    stderrFile.end();
    // Classification: a run is `killed` only once the process actually died from
    // a signal (cap or `mc kill`); the CLI never pre-marks terminal state.
    const current = getRun(runId);
    let exit;
    if (killedByCap || signal != null)
        exit = "killed";
    else if (exitCode === 0)
        exit = "succeeded";
    else
        exit = "failed";
    if (killedByCap)
        insertEvent(runId, "error", { note: "cap-exceeded", detail: killedByCap });
    const parserHealthy = parseErrors === 0 && sawResult;
    const headAtLaunch = typeof stored.git_head_at_launch === "string" ? stored.git_head_at_launch : null;
    const verification = verify({ ...current, exit }, spec, exitCode, isGit, parserHealthy, headAtLaunch);
    insertEvent(runId, "verify_result", { verdict: verification.verdict, checks: JSON.parse(verification.evidence) });
    updateRun(runId, {
        exit,
        verdict: verification.verdict,
        ended_at: new Date().toISOString(),
        verify_evidence: verification.evidence,
    });
    insertEvent(runId, "exited", { exit, exit_code: exitCode, verdict: verification.verdict });
    await notifyTerminal(getRun(runId), config);
}

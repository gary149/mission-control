import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { ADAPTERS, getAdapter } from "./core/adapters/registry.js";
import { resolveAuth } from "./core/auth.js";
import { loadConfig } from "./core/config.js";
import { eventsAfter, findRun, listRuns, markLost, getRun, insertEvent } from "./core/db.js";
import { launch } from "./core/launch.js";
import { notifyTerminal } from "./core/notify.js";
import { PreflightError } from "./core/types.js";
function fail(message) {
    console.error(`mc: ${message}`);
    process.exit(1);
}
function requireRun(idOrPrefix) {
    if (!idOrPrefix)
        fail("run id required");
    const run = findRun(idOrPrefix);
    if (!run)
        fail(`no run matches "${idOrPrefix}"`);
    return run;
}
function pidAlive(pid) {
    if (!pid)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
const QUEUED_GRACE_MS = 15_000;
function isActive(run) {
    return run.exit === "running" || run.exit === "queued";
}
/**
 * Detect watcher death and missed pushes. A running OR queued row whose
 * SUPERVISOR is gone is lost - even if the harness process itself is still
 * alive, nobody is logging, capping, verifying, or notifying it anymore.
 * The lost transition is atomic (markLost) so a supervisor finishing between
 * our snapshot and the write can never have its terminal truth clobbered.
 * Terminal rows that never got their push (crash mid-delivery) are re-notified.
 */
async function reapLostRuns(runs) {
    const config = loadConfig();
    const out = [];
    for (const run of runs) {
        let current = run;
        if (isActive(current)) {
            const watcherPid = current.supervisor_pid ?? current.pid;
            // Freshly-launched rows have no watcher pid recorded yet; give them grace.
            const young = current.exit === "queued" &&
                watcherPid == null &&
                Date.now() - new Date(current.started_at).getTime() < QUEUED_GRACE_MS;
            if (!young && !pidAlive(watcherPid)) {
                if (markLost(current.id)) {
                    const orphanedHarness = current.pid != null && pidAlive(current.pid);
                    insertEvent(current.id, "exited", {
                        exit: "lost",
                        note: orphanedHarness
                            ? `supervisor died; harness pid ${current.pid} may still be running unwatched`
                            : "watcher died without a terminal row",
                    });
                }
                current = getRun(current.id);
            }
        }
        if (!isActive(current) && !current.notified) {
            await notifyTerminal(current, config);
            current = getRun(current.id) ?? current;
        }
        out.push(current);
    }
    return out;
}
function age(iso) {
    const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 90)
        return `${Math.round(seconds)}s`;
    if (seconds < 5400)
        return `${Math.round(seconds / 60)}m`;
    if (seconds < 129600)
        return `${Math.round(seconds / 3600)}h`;
    return `${Math.round(seconds / 86400)}d`;
}
function parseRunArgs(args) {
    let harness = null;
    let model = null;
    let cwd = null;
    let budget = null;
    let maxMinutes = null;
    let gateway = null;
    let apiKey = false;
    let visual = false;
    const artifacts = [];
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = () => {
            const value = args[++i];
            if (value === undefined)
                fail(`${arg} requires a value`);
            return value;
        };
        const nextPositive = () => {
            const value = Number(next());
            if (!Number.isFinite(value) || value <= 0)
                fail(`${arg} must be a finite positive number`);
            return value;
        };
        switch (arg) {
            case "--harness":
                harness = next();
                break;
            case "--model":
                model = next();
                break;
            case "--cwd":
                cwd = next();
                break;
            case "--budget":
                budget = nextPositive();
                break;
            case "--max-minutes":
                maxMinutes = nextPositive();
                break;
            case "--gateway":
                gateway = next();
                break;
            case "--api-key":
                apiKey = true;
                break;
            case "--visual":
                visual = true;
                break;
            case "--artifact":
                artifacts.push(next());
                break;
            case "--effort":
                fail("--effort is not supported in v0 (no harness passthrough is verified; see SPEC.md)");
                break;
            default:
                if (arg.startsWith("--"))
                    fail(`unknown flag ${arg}`);
                positional.push(arg);
        }
    }
    if (!harness)
        fail("--harness is required");
    if (gateway && apiKey)
        fail("--gateway and --api-key are mutually exclusive");
    const prompt = positional.join(" ").trim();
    if (!prompt)
        fail("a prompt is required");
    return {
        spec: {
            harness,
            model,
            prompt,
            cwd,
            artifacts,
            visual,
            budget_usd: budget,
            max_minutes: maxMinutes,
            auth: gateway ? { mode: "gateway", gateway } : apiKey ? { mode: "api_key" } : { mode: "subscription" },
        },
    };
}
async function readSpecFromStdin() {
    const raw = await text(process.stdin);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        fail(`--spec -: stdin is not valid JSON`);
    }
    // Same fail-closed validation as the flag form - this is the remote-safe
    // surface, where a malformed payload is the most likely failure mode.
    if (typeof parsed?.harness !== "string" || !parsed.harness)
        fail(`--spec -: "harness" (string) is required`);
    if (typeof parsed?.prompt !== "string" || !parsed.prompt.trim())
        fail(`--spec -: "prompt" (string) is required`);
    return {
        harness: parsed.harness,
        model: parsed.model ?? null,
        prompt: parsed.prompt,
        cwd: parsed.cwd ?? null,
        artifacts: parsed.artifacts ?? [],
        visual: parsed.visual ?? false,
        budget_usd: parsed.budget_usd ?? null,
        max_minutes: parsed.max_minutes ?? null,
        auth: parsed.auth ?? { mode: "subscription" },
    };
}
/**
 * mc harness check: never mock the boundary we own. Runs the REAL installed CLI
 * end to end on a trivial deterministic task and asserts the full path - launch,
 * events, session_id, exit, verify, cost extraction, and native resume when
 * declared. Costs cents by design; run when writing an adapter or after a CLI
 * update. The runs it creates are ordinary ledger rows (visible in mc ls).
 */
async function harnessCheck(args) {
    const name = args[0];
    if (!name)
        fail("usage: mc harness check <name> [--gateway NAME] [--model M]");
    let gateway = null;
    let model = null;
    for (let i = 1; i < args.length; i++) {
        if (args[i] === "--gateway")
            gateway = args[++i] ?? fail("--gateway requires a value");
        else if (args[i] === "--model")
            model = args[++i] ?? fail("--model requires a value");
        else
            fail(`unknown flag ${args[i]}`);
    }
    const adapter = getAdapter(name);
    const failures = [];
    const report = (label, ok, detail) => {
        console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
        if (!ok)
            failures.push(label);
    };
    const waitTerminal = async (id, timeoutMs) => {
        const start = Date.now();
        for (;;) {
            const current = (await reapLostRuns([getRun(id)]))[0];
            if (!isActive(current))
                return current;
            if (Date.now() - start > timeoutMs)
                fail(`check run ${id} did not terminate within ${timeoutMs / 60000} minutes`);
            await sleep(1000);
        }
    };
    console.log(`checking ${name}${gateway ? ` via gateway ${gateway}` : ""} (this runs the real CLI and costs real usage)`);
    const marker = `mc harness check ${Math.random().toString(36).slice(2, 8)}`;
    const spec = {
        harness: name,
        model,
        prompt: `Create a file mc-check.txt containing exactly this one line: ${marker}`,
        cwd: null,
        artifacts: ["mc-check.txt"],
        visual: false,
        budget_usd: null,
        max_minutes: 10,
        auth: gateway ? { mode: "gateway", gateway } : { mode: "subscription" },
    };
    const run = launch(spec);
    console.log(`  run ${run.id} launched...`);
    const done = await waitTerminal(run.id, 10 * 60_000);
    report("exit=succeeded", done.exit === "succeeded", `got ${done.exit}`);
    report("verdict=verified", done.verdict === "verified", `got ${done.verdict}`);
    report("session_id captured", done.session_id != null, done.session_id ?? "missing");
    const content = existsSync(join(done.workdir, "mc-check.txt"))
        ? readFileSync(join(done.workdir, "mc-check.txt"), "utf8")
        : "";
    report("artifact content exact", content.trim() === marker, content.trim().slice(0, 60));
    report("tokens extracted", done.tokens_out != null && done.tokens_out > 0, `out=${done.tokens_out}`);
    if (adapter.capabilities.cost_reporting === "per_run" && done.cost_basis === "metered_reported") {
        report("cost extracted (declared per_run + metered)", done.cost_usd != null, `$${done.cost_usd}`);
    }
    if (adapter.capabilities.resume === "native" && done.session_id) {
        const resumed = launch({
            ...spec,
            prompt: `Append exactly this one line to mc-check.txt: resumed OK`,
            artifacts: ["mc-check.txt"],
        }, { parent: done });
        console.log(`  resume run ${resumed.id} launched...`);
        const resumedDone = await waitTerminal(resumed.id, 10 * 60_000);
        report("resume exit=succeeded", resumedDone.exit === "succeeded", `got ${resumedDone.exit}`);
        const after = existsSync(join(done.workdir, "mc-check.txt"))
            ? readFileSync(join(done.workdir, "mc-check.txt"), "utf8")
            : "";
        report("resume continued in same workdir", after.includes("resumed OK") && after.includes(marker), after.trim().slice(0, 80));
        report("resume captured a session_id", resumedDone.session_id != null, resumedDone.session_id ?? "missing");
    }
    if (failures.length > 0) {
        console.error(`\n${failures.length} check(s) failed for ${name}`);
        process.exit(1);
    }
    console.log(`\nall checks passed for ${name}`);
}
function printHelp() {
    const version = createRequire(import.meta.url)("../package.json").version;
    const harnesses = ADAPTERS.map((a) => a.name).join(", ");
    const gateways = Object.keys(loadConfig().gateways).join(", ");
    console.log(`mission-control v${version} - control plane for delegated agent runs

USAGE
  mc <command> [options]

COMMANDS
  run           Launch a tracked, isolated, verified run on a harness
  resume <id>   Continue a run's harness session with a follow-up prompt: a new
                linked run in the SAME workdir (inherits harness/model/auth)
  ls            List runs; also reaps lost runs and re-delivers missed notifications
  show <id>     Full run record, verification evidence, recent events
  tail <id>     Follow a run's event stream until it terminates
  kill <id>     Request termination (state lands when the process actually dies)
  harness ls    Adapters: capabilities, install status, live auth probes
  harness check <name> [--gateway G] [--model M]
                Live end-to-end validation against the REAL CLI (costs cents):
                launch, verify, session_id, cost/token extraction, native resume
  help          This page (also: -h, --help anywhere)

RUN OPTIONS
  --harness H       Required. Registered: ${harnesses}
  --model M         Model id; gateway mode needs a provider prefix (moonshotai/kimi-k3)
  --cwd DIR         Git repo to work on; isolated via git worktree (non-git refused)
  --artifact PATH   Declared deliverable, workdir-relative; the verifier checks it
                    exists and is non-empty (repeatable)
  --visual          Output needs human eyes; verdict terminates at needs_human_look
  --max-minutes N   Wall-clock cap: kill + notify when exceeded
  --budget N        Dollar cap; refused where no enforceable cost signal exists
  --gateway NAME    Route via an LLM gateway. Known: ${gateways}
  --api-key         Use the conventional API-key env var instead of the resident login
  --spec -          Read a full RunSpec as JSON from stdin (the remote-safe form:
                    ssh box mc run --spec - < task.json)

AUTH (per run; default = subscription)
  subscription   The harness CLI's own resident login on THIS host; mc adds nothing
  api_key        Forwards exactly one env var resident on this host (ANTHROPIC_API_KEY)
  gateway        OpenRouter-compatible routing; key env var must be resident here
  Credentials never cross machines; missing ones fail closed at preflight.

STATUS (two axes, never conflated)
  exit      queued | running | succeeded | failed | killed | lost
  verdict   pending | verified | failed_verification | unverifiable | needs_human_look
  DONE means succeeded AND verified: declared checks passed, confirmed mechanically,
  never taken from the agent's own claims.

FILES & ENV
  ~/.mission-control/       state root (override: MC_HOME)
    mc.db                   runs + events (SQLite; any tool can read it)
    runs/<id>/              spec.json, work/, stdout.jsonl, stderr.log
    config.toml             [notify] exec/webhook hooks; [gateway.NAME] blocks
  MC_CLAUDE_BIN             override the claude binary path (pinning/testing)

EXAMPLES
  mc run --harness claude-code --artifact out/report.md "write the report"
  mc run --harness claude-code --gateway openrouter --model moonshotai/kimi-k3 \\
        --max-minutes 30 --artifact hello.txt "build hello.txt"
  mc ls --json | jq '.[0].verdict'
  mc harness ls`);
}
export async function cliMain(argv) {
    if (argv.includes("--help") || argv.includes("-h")) {
        printHelp();
        return;
    }
    const [command, ...args] = argv;
    try {
        switch (command) {
            case "run": {
                const spec = args[0] === "--spec" && args[1] === "-" ? await readSpecFromStdin() : parseRunArgs(args).spec;
                const run = launch(spec);
                console.log(`${run.id}  ${run.title}`);
                console.log(`    harness=${run.harness} model=${run.model ?? "(default)"} auth=${run.auth_mode} cost_basis=${run.cost_basis}`);
                console.log(`    workdir=${run.workdir}`);
                console.log(`    mc tail ${run.id}   # follow`);
                break;
            }
            case "ls": {
                const runs = await reapLostRuns(listRuns());
                if (args.includes("--json")) {
                    console.log(JSON.stringify(runs, null, 2));
                    break;
                }
                if (runs.length === 0) {
                    console.log("no runs");
                    break;
                }
                const header = ["ID", "TITLE", "HARNESS", "MODEL", "EXIT", "VERDICT", "COST", "AGE"];
                const rows = runs.map((r) => [
                    r.id,
                    r.title.slice(0, 40),
                    r.harness,
                    (r.model ?? "").slice(0, 24),
                    r.exit,
                    r.verdict,
                    r.cost_usd != null ? `$${r.cost_usd.toFixed(2)}` : r.cost_basis === "flat_subscription" ? "plan" : "-",
                    age(r.started_at),
                ]);
                const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
                for (const row of [header, ...rows]) {
                    console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("  "));
                }
                break;
            }
            case "show": {
                const run = (await reapLostRuns([requireRun(args[0])]))[0];
                console.log(JSON.stringify(run, null, 2));
                const recent = eventsAfter(run.id, 0).slice(-10);
                if (recent.length > 0) {
                    console.log("\nlast events:");
                    for (const event of recent)
                        console.log(`  [${event.seq}] ${event.kind} ${JSON.stringify(event.payload).slice(0, 120)}`);
                }
                break;
            }
            case "tail": {
                const run = requireRun(args[0]);
                let seq = 0;
                for (;;) {
                    for (const event of eventsAfter(run.id, seq)) {
                        seq = event.seq;
                        console.log(`${event.ts} ${event.kind} ${JSON.stringify(event.payload)}`);
                    }
                    // Reap here too - otherwise a dead supervisor leaves tail polling a
                    // frozen `running` row forever.
                    const current = (await reapLostRuns([getRun(run.id)]))[0];
                    if (!["running", "queued"].includes(current.exit) && eventsAfter(run.id, seq).length === 0) {
                        console.log(`-- terminal: exit=${current.exit} verdict=${current.verdict} --`);
                        break;
                    }
                    await sleep(500);
                }
                break;
            }
            case "kill": {
                const run = requireRun(args[0]);
                if (run.exit !== "running")
                    fail(`run ${run.id} is not running (exit=${run.exit})`);
                // Request only - the run stays `running` until the supervisor observes
                // the process actually die (close signal) and writes the terminal row.
                insertEvent(run.id, "status_change", { kill_requested: true, by: "mc kill" });
                if (run.pid) {
                    try {
                        process.kill(run.pid, "SIGTERM");
                    }
                    catch {
                        /* already gone; reap on next ls */
                    }
                }
                console.log(`kill requested for ${run.id} (mc tail ${run.id} to watch it land)`);
                break;
            }
            case "resume": {
                const parent = requireRun(args[0]);
                // A continuation inherits everything verification-relevant from the
                // parent's archived spec - harness/model/auth AND artifacts/visual/
                // caps - unless explicitly overridden. Silently dropping the parent's
                // declared checks was how continuation runs lost their verifiability
                // (fleet evidence: every artifact-less resume capped below verified).
                const parentStored = JSON.parse(readFileSync(parent.spec_path, "utf8"));
                let maxMinutes;
                let budget;
                let visual;
                const artifacts = [];
                const positional = [];
                for (let i = 1; i < args.length; i++) {
                    const arg = args[i];
                    const next = () => {
                        const value = args[++i];
                        if (value === undefined)
                            fail(`${arg} requires a value`);
                        return value;
                    };
                    const nextPositive = () => {
                        const value = Number(next());
                        if (!Number.isFinite(value) || value <= 0)
                            fail(`${arg} must be a finite positive number`);
                        return value;
                    };
                    switch (arg) {
                        case "--artifact":
                            artifacts.push(next());
                            break;
                        case "--max-minutes":
                            maxMinutes = nextPositive();
                            break;
                        case "--budget":
                            budget = nextPositive();
                            break;
                        case "--visual":
                            visual = true;
                            break;
                        case "--no-visual":
                            visual = false;
                            break;
                        default:
                            if (arg.startsWith("--"))
                                fail(`unknown flag ${arg} (resume inherits spec fields from the parent)`);
                            positional.push(arg);
                    }
                }
                const prompt = positional.join(" ").trim();
                if (!prompt)
                    fail("a follow-up prompt is required");
                const run = launch({
                    harness: parent.harness,
                    model: parent.model,
                    prompt,
                    cwd: null,
                    artifacts: artifacts.length > 0 ? artifacts : (parentStored.artifacts ?? []),
                    visual: visual ?? Boolean(parentStored.visual),
                    budget_usd: budget !== undefined ? budget : (parentStored.budget_usd ?? null),
                    max_minutes: maxMinutes !== undefined ? maxMinutes : (parentStored.max_minutes ?? null),
                    auth: parentStored.auth ?? { mode: "subscription" },
                }, { parent });
                console.log(`${run.id}  ${run.title}`);
                console.log(`    resumes ${parent.id} (session ${parent.session_id}) in ${run.workdir}`);
                console.log(`    mc tail ${run.id}   # follow`);
                break;
            }
            case "harness": {
                if (args[0] === "check") {
                    await harnessCheck(args.slice(1));
                    break;
                }
                if (args[0] !== "ls")
                    fail("usage: mc harness ls | mc harness check <name> [--gateway NAME] [--model M]");
                const config = loadConfig();
                for (const adapter of ADAPTERS) {
                    const detection = adapter.detect();
                    console.log(`${adapter.name}`);
                    console.log(`  installed: ${detection.installed ? `yes (${detection.path}, ${detection.version ?? "?"})` : "no"}`);
                    console.log(`  capabilities: ${JSON.stringify(adapter.capabilities)}`);
                    for (const mode of adapter.capabilities.auth_modes) {
                        let probe;
                        try {
                            const spec = {
                                harness: adapter.name, model: mode === "gateway" ? "probe/probe" : null, prompt: "probe",
                                cwd: null, artifacts: [], visual: false, budget_usd: null, max_minutes: null,
                                auth: mode === "gateway" ? { mode, gateway: "openrouter" } : { mode },
                            };
                            const resolved = resolveAuth(spec, adapter, config);
                            probe = `ready (${resolved.source})`;
                        }
                        catch (error) {
                            probe = error instanceof PreflightError ? `missing (${error.message.split(";")[0]})` : "error";
                        }
                        console.log(`  auth ${mode}: ${probe}`);
                    }
                }
                break;
            }
            case "help":
            case undefined:
                printHelp();
                break;
            default:
                fail(`unknown command "${command}" (try: mc help)`);
        }
    }
    catch (error) {
        if (error instanceof PreflightError)
            fail(error.message);
        throw error;
    }
}

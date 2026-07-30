import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { ADAPTERS, getAdapter } from "./core/adapters/registry.ts";
import { checkGatewayModelServed, resolveAuth } from "./core/auth.ts";
import { ensureHome, loadConfig, malformedLines, mcHome, quoteTomlString, type NotifyTarget } from "./core/config.ts";
import {
  assessmentsFor,
  eventsAfter,
  findRun,
  insertAssessment,
  latestAssessment,
  listRuns,
  markLost,
  getRun,
  insertEvent,
  unnotifiedAssessments,
} from "./core/db.ts";
import { launch } from "./core/launch.ts";
import { notifyAssessment, notifyTerminal, sendTest } from "./core/notify.ts";
import { evaluateWorktree, pruneWorktree } from "./core/prune.ts";
import { PreflightError, type Disposition, type ExitStatus, type Run, type RunSpec } from "./core/types.ts";

function fail(message: string): never {
  console.error(`mc: ${message}`);
  process.exit(1);
}

function requireRun(idOrPrefix: string | undefined): Run {
  if (!idOrPrefix) fail("run id required");
  const run = findRun(idOrPrefix);
  if (!run) fail(`no run matches "${idOrPrefix}"`);
  return run;
}

// Every exit value, compile-checked for exhaustiveness against the union in
// types.ts: adding a member there without updating here fails to typecheck.
const EXIT_VALUES = Object.keys({
  queued: 1, running: 1, succeeded: 1, failed: 1, killed: 1, lost: 1,
} satisfies Record<ExitStatus, 1>);

// Every disposition value, same exhaustiveness trick as EXIT_VALUES above.
const DISPOSITION_VALUES = Object.keys({
  accepted: 1, retry: 1, blocked: 1,
} satisfies Record<Disposition, 1>);

// "pending" is not a Disposition - it is the ABSENCE of any assessment row
// (see db.ts's assessments table comment) - so it is added here, at the CLI's
// filter-vocabulary layer, rather than smuggled into the Disposition type
// itself where it would wrongly imply mc ever stores it.
const REVIEW_VALUES = ["pending", ...DISPOSITION_VALUES];

/**
 * Comma-separated, repeatable value filter shared by `mc ls --exit` and `mc
 * ls --review` (originally just `--exit`, generalized once `--review` needed
 * the identical parsing/validation shape). Unknown values fail loudly with
 * the valid set - a typo that silently matched nothing would read as "no
 * runs in that state". A supplied flag whose tokens are all empty (e.g.
 * `--exit ','`, or automation interpolating an empty variable) must not
 * degrade to "no filter" either: that returns the full unfiltered ledger with
 * exit 0, the worst case for an automated consumer expecting filtered output.
 */
function parseValueFilter(args: string[], flag: string, validValues: string[]): Set<string> | null {
  const values: string[] = [];
  let seen = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    seen = true;
    const next = args[i + 1];
    if (!next || next.startsWith("--")) fail(`${flag} requires a value (${validValues.join(", ")})`);
    values.push(...next.split(",").map((v) => v.trim()).filter(Boolean));
    i++;
  }
  if (!seen) return null;
  if (values.length === 0) fail(`${flag} requires a value (${validValues.join(", ")})`);
  for (const v of values) {
    if (!validValues.includes(v)) fail(`unknown ${flag} value "${v}" (valid: ${validValues.join(", ")})`);
  }
  return new Set(values);
}

function parseExitFilter(args: string[]): Set<string> | null {
  return parseValueFilter(args, "--exit", EXIT_VALUES);
}

function parseReviewFilter(args: string[]): Set<string> | null {
  return parseValueFilter(args, "--review", REVIEW_VALUES);
}

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signal the harness's whole process GROUP (it's spawned `detached: true` by
 * the supervisor, making it a group leader) so descendants die too, not just
 * the recorded pid. Falls back to signalling the bare pid if the group is
 * already gone or unavailable (e.g. a pid whose group predates this fix, or
 * a process that was never a group leader). Returns which path landed -
 * callers escalating a SIGTERM need to know, because the two paths require
 * different liveness checks afterward (see killWithEscalation).
 */
function killGroupOrPid(pid: number, signal: NodeJS.Signals): "group" | "bare" {
  try {
    process.kill(-pid, signal);
    return "group";
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
    return "bare";
  }
}

/**
 * Whether the harness's process GROUP still has any member alive - checked
 * via signal 0 against the negative pid, which throws ESRCH only once every
 * process in the group is gone. Deliberately broader than checking the
 * leader pid alone: if the harness exits on SIGTERM but a descendant it
 * spawned ignores it, the leader pid disappears (a plain `pidAlive` check
 * would read "dead" and skip SIGKILL) while the group - and a
 * pipe-holding descendant that can block the supervisor's close event -
 * survives. Escalation must track the group, not the leader.
 */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `mc kill` is a short-lived CLI invocation, not a resident watcher, so the
 * SIGTERM-then-SIGKILL escalation happens inline here rather than being
 * scheduled and left to outlive the process: send SIGTERM, poll liveness for
 * up to `timeoutMs`, then SIGKILL if it's still standing.
 *
 * WHICH liveness check to poll depends on which path the SIGTERM actually
 * took. The normal case (detached:true group leader) sends a real group
 * signal, so the GROUP is what has to disappear - poll `groupAlive`. But
 * when `killGroupOrPid` had to fall back to a bare-pid signal (no such
 * process group exists - e.g. a run launched before the detached:true fix,
 * or a pid that was never a group leader), `process.kill(-pid, 0)` throws
 * ESRCH immediately regardless of whether the process itself is still
 * alive: polling `groupAlive` there would read "dead" on the very first
 * check and skip SIGKILL entirely for a process that's actively ignoring
 * SIGTERM. Track the path from the initial signal and poll - and escalate
 * SIGKILL via - the matching check in both branches.
 */
async function killWithEscalation(pid: number, timeoutMs = 10_000): Promise<void> {
  const path = killGroupOrPid(pid, "SIGTERM");
  const alive = () => (path === "group" ? groupAlive(pid) : pidAlive(pid));
  const start = Date.now();
  while (alive() && Date.now() - start < timeoutMs) {
    await sleep(250);
  }
  if (alive()) killGroupOrPid(pid, "SIGKILL");
}

/** Live process start time - see supervisor.ts's matching `pidStart` for why `ps -o lstart=`. */
function pidStart(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const out = result.stdout.trim();
  return out || null;
}

/**
 * The harness pid's start time as the supervisor recorded it at spawn (the
 * `pid_start` field on its initial `status_change` event - see
 * supervisor.ts). Scans rather than indexes: this is a once-per-kill,
 * bounded-size read, consistent with how `show`/`tail` already walk a run's
 * event stream.
 */
function recordedPidStart(runId: string, pid: number): string | null {
  for (const event of eventsAfter(runId, 0)) {
    if (event.kind !== "status_change") continue;
    const payload = event.payload as { pid?: number; pid_start?: string | null };
    if (payload.pid === pid && typeof payload.pid_start === "string") return payload.pid_start;
  }
  return null;
}

/**
 * Authoritative identity check before signalling a run whose supervisor is
 * NOT confirmably alive (a `lost` row, including one just reaped from
 * `running` - see the `kill` handler). A pid can be reused - by an
 * unrelated process, or by a DIFFERENT concurrent run of the SAME harness
 * binary, which a command-line match cannot tell apart. Process start time
 * is per-instance and authoritative: it's assigned once, at fork, and
 * nothing short of the same process can produce it again. Fails SAFE - a
 * missing recorded value, a vanished live process, or any mismatch all
 * refuse rather than risk signalling the wrong process.
 */
function looksLikeOwnedProcess(run: Run): boolean {
  if (!run.pid) return false;
  const recorded = recordedPidStart(run.id, run.pid);
  if (!recorded) return false;
  return pidStart(run.pid) === recorded;
}

const QUEUED_GRACE_MS = 15_000;

function isActive(run: Run): boolean {
  return run.exit === "running" || run.exit === "queued";
}

/**
 * Detect watcher death and missed pushes. A running OR queued row whose
 * SUPERVISOR is gone is lost - even if the harness process itself is still
 * alive, nobody is logging, capping, verifying, or notifying it anymore.
 * The lost transition is atomic (markLost) so a supervisor finishing between
 * our snapshot and the write can never have its terminal truth clobbered.
 * This detection always runs, for every caller.
 *
 * `deliver` gates a SEPARATE concern: whether a terminal-but-unnotified row
 * also gets a (re)dispatch attempt here. Read commands (`ls`/`show`/`tail`,
 * and `harness check`'s poll) must pass false and stay side-effect free -
 * they only report the current truth, undelivered or not. Only `mc reap`
 * (the cron-safe delivery path SPEC designates) passes true; the supervisor
 * delivers too, but via its own direct notifyTerminal call at terminal, not
 * through this function.
 *
 * Why read commands can't deliver: fix 2 (retry on full delivery failure)
 * leaves `notified` false so a permanently-failing hook gets retried by a
 * later `mc reap`. If a read command dispatched too, `mc tail` - which polls
 * every 500ms and only breaks once a terminal row produces no NEW events -
 * would see notifyTerminal's own fresh notify_result event as "new" on every
 * poll and never break, hammering the failing hook forever.
 *
 * `deliver` defaults to false: a caller that doesn't explicitly opt into
 * delivery must not deliver, since false is the safe choice (it never
 * spuriously fires a hook). Every delivering call site (`mc reap`, `mc
 * harness check`'s poll) passes `true` explicitly; any caller that omits the
 * argument - including ones added later without knowing about this flag -
 * correctly falls back to the non-delivering, side-effect-free read path.
 */
async function reapLostRuns(runs: Run[], deliver = false): Promise<Run[]> {
  const config = deliver ? loadConfig() : null;
  const out: Run[] = [];
  for (const run of runs) {
    let current = run;
    if (isActive(current)) {
      const watcherPid = current.supervisor_pid ?? current.pid;
      // Freshly-launched rows have no watcher pid recorded yet; give them grace.
      const young =
        current.exit === "queued" &&
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
        current = getRun(current.id)!;
      }
    }
    if (deliver && !isActive(current) && !current.notified) {
      await notifyTerminal(current, config!);
      current = getRun(current.id) ?? current;
    }
    out.push(current);
  }
  return out;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["K", "M", "G", "T"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
}

function age(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

// Wall-clock span of the run itself (started_at -> ended_at), distinct from
// age() which measures time since start and keeps counting for runs still
// going. A run with no ended_at yet (still running/queued) has no duration
// to report - "-" rather than a misleading in-progress number that would
// look like a final total.
function duration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "-";
  const seconds = Math.max(0, (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000);
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

// Compact token count for table display: 73000 -> "73k", 950 -> "950".
function compactTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

function tokensCell(r: Pick<Run, "tokens_in" | "tokens_out">): string {
  if (r.tokens_in == null && r.tokens_out == null) return "-";
  return `${compactTokens(r.tokens_in ?? 0)}/${compactTokens(r.tokens_out ?? 0)}`;
}

/**
 * The REVIEW column / summary-line value for a run: "-" while a run is still
 * active (review begins only after the process stops - see `mc assess`'s own
 * refusal), the latest disposition once a reviewer has recorded one, or the
 * literal string "pending" for a terminal run with none. "pending" is
 * computed here, at display time, from the ABSENCE of a row - it is never
 * itself stored (see db.ts's assessments table comment).
 */
function reviewStatus(run: Run): string {
  if (isActive(run)) return "-";
  return latestAssessment(run.id)?.disposition ?? "pending";
}

interface ParsedRunArgs {
  spec: RunSpec;
}

function parseRunArgs(args: string[]): ParsedRunArgs {
  let harness: string | null = null;
  let model: string | null = null;
  let cwd: string | null = null;
  let budget: number | null = null;
  let maxMinutes: number | null = null;
  let maxIdleMinutes: number | null = null;
  let gateway: string | null = null;
  let apiKey = false;
  const artifacts: string[] = [];
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = () => {
      const value = args[++i];
      if (value === undefined) fail(`${arg} requires a value`);
      return value;
    };
    const nextPositive = () => {
      const value = Number(next());
      if (!Number.isFinite(value) || value <= 0) fail(`${arg} must be a finite positive number`);
      return value;
    };
    const nextNonNegative = () => {
      const value = Number(next());
      if (!Number.isFinite(value) || value < 0) fail(`${arg} must be a finite number >= 0 (0 disables)`);
      return value;
    };
    switch (arg) {
      case "--harness": harness = next(); break;
      case "--model": model = next(); break;
      case "--cwd": cwd = next(); break;
      case "--budget": budget = nextPositive(); break;
      case "--max-minutes": maxMinutes = nextPositive(); break;
      case "--max-idle-minutes": maxIdleMinutes = nextNonNegative(); break;
      case "--gateway": gateway = next(); break;
      case "--api-key": apiKey = true; break;
      case "--artifact": artifacts.push(next()); break;
      case "--effort":
        fail("--effort is not supported in v0 (no harness passthrough is verified; see SPEC.md)");
        break;
      default:
        if (arg.startsWith("--")) fail(`unknown flag ${arg}`);
        positional.push(arg);
    }
  }

  if (!harness) fail("--harness is required");
  if (gateway && apiKey) fail("--gateway and --api-key are mutually exclusive");
  const prompt = positional.join(" ").trim();
  if (!prompt) fail("a prompt is required");

  return {
    spec: {
      harness,
      model,
      prompt,
      cwd,
      artifacts,
      budget_usd: budget,
      max_minutes: maxMinutes,
      max_idle_minutes: maxIdleMinutes,
      auth: gateway ? { mode: "gateway", gateway } : apiKey ? { mode: "api_key" } : { mode: "subscription" },
    },
  };
}

async function readSpecFromStdin(): Promise<RunSpec> {
  const raw = await text(process.stdin);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`--spec -: stdin is not valid JSON`);
  }
  // Same fail-closed validation as the flag form - this is the remote-safe
  // surface, where a malformed payload is the most likely failure mode.
  if (typeof parsed?.harness !== "string" || !parsed.harness) fail(`--spec -: "harness" (string) is required`);
  if (typeof parsed?.prompt !== "string" || !parsed.prompt.trim()) fail(`--spec -: "prompt" (string) is required`);
  return {
    harness: parsed.harness,
    model: parsed.model ?? null,
    prompt: parsed.prompt,
    cwd: parsed.cwd ?? null,
    artifacts: parsed.artifacts ?? [],
    budget_usd: parsed.budget_usd ?? null,
    max_minutes: parsed.max_minutes ?? null,
    max_idle_minutes: parsed.max_idle_minutes ?? null,
    auth: parsed.auth ?? { mode: "subscription" },
  };
}

/**
 * mc harness check: never mock the boundary we own. Runs the REAL installed CLI
 * end to end on a trivial deterministic task and asserts the full path - launch,
 * events, session_id, exit, artifact content, cost extraction, and native resume
 * when declared. Costs cents by design; run when writing an adapter or after a CLI
 * update. The runs it creates are ordinary ledger rows (visible in mc ls).
 */
async function harnessCheck(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) fail("usage: mc harness check <name> [--gateway NAME] [--model M]");
  let gateway: string | null = null;
  let model: string | null = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--gateway") gateway = args[++i] ?? fail("--gateway requires a value");
    else if (args[i] === "--model") model = args[++i] ?? fail("--model requires a value");
    else fail(`unknown flag ${args[i]}`);
  }
  const adapter = getAdapter(name);
  const failures: string[] = [];
  const report = (label: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
    if (!ok) failures.push(label);
  };

  const waitTerminal = async (id: string, timeoutMs: number): Promise<Run> => {
    const start = Date.now();
    for (;;) {
      // Not one of the general read commands: this polls a run `mc harness
      // check` itself just launched, and breaks the instant it goes
      // terminal (no "wait for a quiet poll" condition), so it can't loop
      // hammering a hook the way `mc tail` could. Delivering here is
      // harmless either way - the atomic claim (fix 3) means it can only
      // ever race the supervisor's own dispatch, never double-fire.
      const current = (await reapLostRuns([getRun(id)!], true))[0]!;
      if (!isActive(current)) return current;
      if (Date.now() - start > timeoutMs) fail(`check run ${id} did not terminate within ${timeoutMs / 60000} minutes`);
      await sleep(1000);
    }
  };

  console.log(`checking ${name}${gateway ? ` via gateway ${gateway}` : ""} (this runs the real CLI and costs real usage)`);
  const marker = `mc harness check ${Math.random().toString(36).slice(2, 8)}`;
  const spec: RunSpec = {
    harness: name,
    model,
    prompt: `Create a file mc-check.txt containing exactly this one line: ${marker}`,
    cwd: null,
    artifacts: ["mc-check.txt"],
    budget_usd: null,
    max_minutes: 10,
    max_idle_minutes: 10,
    auth: gateway ? { mode: "gateway", gateway } : { mode: "subscription" },
  };
  const run = launch(spec);
  console.log(`  run ${run.id} launched...`);
  const done = await waitTerminal(run.id, 10 * 60_000);

  report("exit=succeeded", done.exit === "succeeded", `got ${done.exit}`);
  report("session_id captured", done.session_id != null, done.session_id ?? "missing");
  const content = existsSync(join(done.workdir, "mc-check.txt"))
    ? readFileSync(join(done.workdir, "mc-check.txt"), "utf8")
    : "";
  report("artifact content exact", content.trim() === marker, content.trim().slice(0, 60));
  if (adapter.capabilities.tokens_reporting === "reported") {
    report("tokens extracted", done.tokens_out != null && done.tokens_out > 0, `out=${done.tokens_out}`);
  }
  if (adapter.capabilities.cost_reporting === "per_run" && done.cost_basis === "metered_reported") {
    report("cost extracted (declared per_run + metered)", done.cost_usd != null, `$${done.cost_usd}`);
  }

  if (adapter.capabilities.resume === "native" && done.session_id) {
    const resumed = launch(
      {
        ...spec,
        prompt: `Append exactly this one line to mc-check.txt: resumed OK`,
        artifacts: ["mc-check.txt"],
      },
      { parent: done },
    );
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

const REAP_CRON_TAG = "# mission-control-reap";

/**
 * Replace (or append) a single top-level `[section]` block in TOML text,
 * leaving every OTHER line byte-for-byte untouched. mc only ever owns
 * [notify] and [notify.assessment] in config.toml - hand-authored [gateway.*]
 * blocks, comments, and anything else an operator added must survive `mc
 * init` verbatim. There is no general TOML *writer* here on purpose - only
 * enough text surgery to own exactly the sections mc owns, which is also
 * what makes re-running `mc init` with the same flags byte-for-byte
 * idempotent.
 */
function upsertTomlSection(text: string, section: string, lines: string[]): string {
  // Split into lines with no artificial trailing-newline artifact ("a\nb\n"
  // and "a\nb" must normalize to the SAME ["a","b"], or the append path
  // below and the replace path would disagree about whether a blank-line
  // separator already exists - that mismatch was the actual idempotency bug
  // this function used to have (a second `mc init` run with identical flags
  // produced a different config.toml than the first).
  const src = text.split("\n");
  if (src.length > 0 && src[src.length - 1] === "") src.pop();

  const headerRe = new RegExp(`^\\[${section.replace(/\./g, "\\.")}\\]$`);
  const anyHeaderRe = /^\[[A-Za-z0-9_.-]+\]$/;
  let start = -1;
  let end = -1; // exclusive
  for (let i = 0; i < src.length; i++) {
    if (!headerRe.test(src[i]!.trim())) continue;
    start = i;
    end = src.length;
    for (let j = i + 1; j < src.length; j++) {
      if (anyHeaderRe.test(src[j]!.trim())) {
        end = j;
        break;
      }
    }
    break;
  }
  const block = [`[${section}]`, ...lines];

  let out: string[];
  if (start === -1) {
    // Section doesn't exist yet: append it, with a blank-line separator if
    // the file already has other content, none if it's empty.
    out = src.length > 0 ? [...src, "", ...block] : block;
  } else {
    // Replace in place, keeping everything BEFORE the section byte-for-byte
    // (it's never touched). Whatever comes after gets exactly one canonical
    // blank-line separator re-inserted (normalizing away any leftover blank
    // line right after the old block first) - reconstructed the same way
    // every time, which is what makes re-running this idempotent regardless
    // of whether the section being replaced was the first, middle, or last
    // one previously written.
    const before = src.slice(0, start);
    let after = src.slice(end);
    if (after.length > 0 && after[0] === "") after = after.slice(1);
    out = after.length > 0 ? [...before, ...block, "", ...after] : [...before, ...block];
  }
  return `${out.join("\n")}\n`;
}

type CrontabRead = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Read the current user's crontab, FAILING CLOSED on anything ambiguous.
 * `crontab -l` exits nonzero both for "this user genuinely has no crontab
 * yet" (the ordinary, expected case) AND for real failures - permission
 * denied, the binary missing, a transient read error. Those are NOT the same
 * thing, and conflating them used to mean any transient failure here read as
 * "empty crontab" - which installReapCron below would then treat as safe to
 * REPLACE with just mc's own line, destroying whatever the user's actual
 * crontab held. Only the specific, positively-identified "no crontab for
 * this user" message - which both cron implementations observed (vixie-cron/
 * cronie on Linux, the bundled cron on macOS) print to stderr on that exact
 * case - counts as genuinely empty. Anything else is reported as a failure
 * to the caller, never silently swallowed into "".
 */
function readCrontab(): CrontabRead {
  const r = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (r.status === 0) return { ok: true, text: r.stdout };
  if (r.error) return { ok: false, reason: `could not run crontab: ${r.error.message}` };
  if (/no crontab for/i.test(r.stderr ?? "")) return { ok: true, text: "" };
  return { ok: false, reason: (r.stderr ?? "").trim() || `crontab -l exited with status ${r.status}` };
}

/** Informational only (used by `mc init --check`'s display line) - an unreadable crontab reads as "unknown", never a false "absent". */
function reapCronStatus(): "present" | "absent" | "unknown" {
  const read = readCrontab();
  if (!read.ok) return "unknown";
  return read.text.split("\n").some((l) => l.includes(REAP_CRON_TAG)) ? "present" : "absent";
}

/**
 * Idempotent: checks for the tag BEFORE writing, so re-running `mc init
 * --install-reap` never duplicates the line. Removable by hand - the tagged
 * trailing comment is the documented way to find and delete it (`crontab -e`).
 * Refuses to write at all if the existing crontab couldn't be reliably read
 * (see readCrontab) - better to fail the install loudly than risk clobbering
 * a crontab mc failed to see the real contents of.
 */
/** Single-quote a value for embedding in a crontab line's own shell command, escaping any embedded single quotes. */
function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function installReapCron(): { status: "added" | "already-present" | "failed"; detail: string } {
  const read = readCrontab();
  if (!read.ok) {
    return {
      status: "failed",
      detail: `refusing to modify crontab - could not reliably read the existing one: ${read.reason}`,
    };
  }
  if (read.text.split("\n").some((l) => l.includes(REAP_CRON_TAG))) {
    return { status: "already-present", detail: "already present" };
  }
  const mcPath = realpathSync(process.argv[1]!);
  // Cron jobs run with their OWN minimal environment, not this process's -
  // an MC_HOME override active when `--install-reap` runs (a relocated state
  // dir, a test rig) would otherwise silently vanish from the cron job,
  // which would then reap against the DEFAULT ~/.mission-control instead of
  // wherever this invocation was actually configured against. Embed it
  // explicitly, shell-quoted, only when it's actually set - the unset case
  // already resolves to the same default under cron's own HOME.
  const envPrefix = process.env.MC_HOME ? `MC_HOME=${shellQuoteSingle(process.env.MC_HOME)} ` : "";
  const line = `*/10 * * * * ${envPrefix}${mcPath} reap ${REAP_CRON_TAG}`;
  const next = read.text.length > 0 && !read.text.endsWith("\n") ? `${read.text}\n${line}\n` : `${read.text}${line}\n`;
  const r = spawnSync("crontab", ["-"], { input: next, encoding: "utf8" });
  if (r.status !== 0) return { status: "failed", detail: `crontab write failed: ${r.stderr?.trim() || "unknown error"}` };
  return { status: "added", detail: line };
}

/**
 * Whether an exec hook's target looks runnable, WITHOUT running it. Only
 * meaningful when the exec string's first token is a plain existing file (the
 * common case: a script path) - a shell one-liner like `cat > out.json` names
 * no such file, so this returns null (not applicable) rather than a false
 * positive/negative; there is no general way to statically validate an
 * arbitrary shell command.
 */
function execTargetStatus(exec: string): { path: string; executable: boolean } | null {
  const bin = exec.trim().split(/\s+/)[0];
  if (!bin || !existsSync(bin)) return null;
  let executable = true;
  try {
    accessSync(bin, fsConstants.X_OK);
  } catch {
    executable = false;
  }
  return { path: bin, executable };
}

/**
 * Whether EVERY configured channel in a sendTest() result delivered - the
 * health-check policy, deliberately stricter than notifyTerminal/
 * notifyAssessment's real-delivery "any channel is enough" policy (see
 * notify.ts's sendTest doc comment for why the two must differ): a
 * hand-authored section with both exec and webhook configured is only
 * genuinely healthy if BOTH work, not if one silently covers for the other.
 */
function channelsAllOk(channels: Record<string, unknown>): boolean {
  const names = Object.keys(channels);
  return names.length > 0 && names.every((n) => Boolean((channels[n] as { delivered?: boolean } | undefined)?.delivered));
}

/** Per-channel human summary for a sendTest() result, e.g. "exec=OK, webhook=FAILED (status 500)". */
function channelSummary(channels: Record<string, unknown>): string {
  return Object.entries(channels)
    .map(([name, result]) => {
      const r = result as { delivered?: boolean; status?: number; exit_code?: number; error?: string } | undefined;
      if (r?.delivered) return `${name}=OK`;
      const detail = r?.error ?? (r?.status != null ? `status ${r.status}` : r?.exit_code != null ? `exit ${r.exit_code}` : "not delivered");
      return `${name}=FAILED (${detail})`;
    })
    .join(", ");
}

/**
 * Read-only diagnosis: config.toml parseability, hook file existence/
 * executability, crontab entry presence, and a dry test dispatch through
 * every configured hook - changes NOTHING. Exits nonzero the moment anything
 * configured looks broken, so a broken setup is caught before an operator
 * assumes it works (the whole reason `mc init` verifies rather than assumes -
 * the fleet audit found five independent operators with a notify hook that
 * silently never fired).
 */
async function initCheck(): Promise<void> {
  const configPath = join(mcHome(), "config.toml");
  let broken = false;
  const report = (ok: boolean, label: string) => {
    console.log(`  ${ok ? "OK" : "FAIL"}  ${label}`);
    if (!ok) broken = true;
  };

  let configText = "";
  if (existsSync(configPath)) {
    try {
      configText = readFileSync(configPath, "utf8");
      report(true, `${configPath} is readable`);
    } catch (error) {
      report(false, `${configPath} unreadable: ${error}`);
    }
  } else {
    console.log(`  (no config.toml at ${configPath}; defaults apply)`);
  }

  const config = loadConfig();
  const targets: [string, NotifyTarget, string][] = [
    ["[notify]", config.notify, "notify"],
    ["[notify.assessment]", config.notify.assessment, "notify.assessment"],
  ];
  for (const [label, target, sectionName] of targets) {
    // loadConfig()/parseToml() are lenient BY DESIGN (a malformed line is
    // skipped, not fatal to the whole file) - but that means a hook that
    // failed to parse (e.g. an unterminated quoted string) is INDISTINGUISHABLE
    // from "nothing configured" once it reaches `target.exec`/`target.webhook`
    // as null. Check the raw text directly for that specific failure before
    // trusting the parsed (and therefore possibly silently-emptied) result.
    const badLines = configText ? malformedLines(configText, sectionName) : [];
    if (badLines.length > 0) {
      report(false, `${label} has a line that failed to parse (check for an unterminated quoted string): ${badLines[0]}`);
      continue; // nothing usable was actually extracted; the checks below would just report "nothing configured"
    }
    if (target.exec) {
      const status = execTargetStatus(target.exec);
      if (status) report(status.executable, `${label} exec target is executable (${status.path})`);
    }
    if (target.exec || target.webhook) {
      const channels = await sendTest(target);
      report(channelsAllOk(channels), `${label} dry test dispatch delivered (${channelSummary(channels)})`);
    }
  }

  // Crontab presence is informational only - not opting into --install-reap
  // is a valid, common configuration, not a broken one. "unknown" (a
  // genuinely unreadable crontab) is reported as such, never collapsed into
  // a false "absent" - see readCrontab's fail-closed reasoning.
  console.log(`  (info) crontab reap entry: ${reapCronStatus()}`);

  if (broken) {
    console.error("\nmc init --check found problem(s) above; nothing was changed");
    process.exit(1);
  }
  console.log("\nall checks passed; nothing was changed");
}

/**
 * `mc init`: idempotent config.toml writer for the two sections mc owns
 * ([notify], [notify.assessment]), plus the optional crontab reap entry.
 * Verifies rather than assumes: any hook this invocation just wrote (or was
 * just told about again) gets an immediate synthetic test push, and the
 * result is printed - never silently trusted. This is the direct answer to
 * the fleet-audit finding that five independent operators configured a
 * notify hook that never actually fired.
 */
async function runInit(args: string[]): Promise<void> {
  if (args.includes("--check")) return initCheck();

  let notifyExec: string | null = null;
  let notifyWebhook: string | null = null;
  let assessmentExec: string | null = null;
  let assessmentWebhook: string | null = null;
  let installReap = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = () => {
      const value = args[++i];
      if (value === undefined) fail(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--notify-exec": notifyExec = next(); break;
      case "--notify-webhook": notifyWebhook = next(); break;
      case "--assessment-exec": assessmentExec = next(); break;
      case "--assessment-webhook": assessmentWebhook = next(); break;
      case "--install-reap": installReap = true; break;
      default: fail(`unknown flag ${arg}`);
    }
  }
  if (notifyExec && notifyWebhook) fail("--notify-exec and --notify-webhook are mutually exclusive");
  if (assessmentExec && assessmentWebhook) fail("--assessment-exec and --assessment-webhook are mutually exclusive");

  ensureHome();
  const configPath = join(mcHome(), "config.toml");
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  let text = existing;

  // quoteTomlString escapes backslashes/quotes so an exec command containing
  // either (e.g. `cat > "a file.json"`) round-trips through config.toml
  // instead of producing invalid TOML that silently truncates on read-back
  // (raw interpolation used to do exactly that).
  if (notifyExec || notifyWebhook) {
    text = upsertTomlSection(
      text,
      "notify",
      [
        notifyExec ? `exec = ${quoteTomlString(notifyExec)}` : null,
        notifyWebhook ? `webhook = ${quoteTomlString(notifyWebhook)}` : null,
      ].filter((l): l is string => l !== null),
    );
  }
  if (assessmentExec || assessmentWebhook) {
    text = upsertTomlSection(
      text,
      "notify.assessment",
      [
        assessmentExec ? `exec = ${quoteTomlString(assessmentExec)}` : null,
        assessmentWebhook ? `webhook = ${quoteTomlString(assessmentWebhook)}` : null,
      ].filter((l): l is string => l !== null),
    );
  }

  if (text !== existing) {
    // Atomic write: tmp file then rename, so a crash mid-write never leaves a
    // truncated config.toml behind for the next command to half-read.
    const tmp = `${configPath}.tmp-${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, configPath);
    console.log(`wrote ${configPath}`);
  } else if (!existsSync(configPath)) {
    console.log(`no options given; ${configPath} not created (nothing to configure)`);
  } else {
    console.log(`${configPath} unchanged`);
  }

  // Verify, don't assume - every hook this invocation named gets an
  // immediate synthetic push, reported honestly either way. Config.toml is
  // already written above regardless of what happens here (verification
  // failing does not mean the write itself failed); what changes is the
  // process's own exit code, tracked in `anyFailed` below.
  // Every configured channel must actually deliver here, not just "any one
  // of them" - notifyTerminal/notifyAssessment's real-delivery policy treats
  // one working channel as enough (a real push only needs to land somewhere),
  // but a health check auditing a section with BOTH exec and webhook set must
  // not report OK while one of the two is silently broken. See notify.ts's
  // sendTest doc comment.
  let anyFailed = false;
  if (notifyExec || notifyWebhook) {
    const channels = await sendTest({ exec: notifyExec, webhook: notifyWebhook });
    const ok = channelsAllOk(channels);
    console.log(`[notify] verification: ${ok ? "OK" : "FAILED"} (${channelSummary(channels)})`);
    if (!ok) anyFailed = true;
  }
  if (assessmentExec || assessmentWebhook) {
    const channels = await sendTest({ exec: assessmentExec, webhook: assessmentWebhook });
    const ok = channelsAllOk(channels);
    console.log(`[notify.assessment] verification: ${ok ? "OK" : "FAILED"} (${channelSummary(channels)})`);
    if (!ok) anyFailed = true;
  }

  if (installReap) {
    const result = installReapCron();
    console.log(
      result.status === "added"
        ? `crontab: added reap entry (${result.detail})`
        : result.status === "already-present"
          ? "crontab: already present"
          : `crontab: FAILED (${result.detail})`,
    );
    if (result.status === "failed") anyFailed = true;
  }

  // A requested verification or install that failed is exactly the silent
  // false-green `mc init` exists to eliminate - report everything above
  // first (an operator debugging this needs to see ALL the results, not just
  // the first failure), THEN fail the process so automation (a setup script,
  // CI) notices without having to grep stdout for "FAILED".
  if (anyFailed) {
    console.error("\nmc init: one or more requested verifications or installs failed (see FAILED lines above)");
    process.exit(1);
  }
}

function printHelp(): void {
  const version = createRequire(import.meta.url)("../package.json").version as string;
  const harnesses = ADAPTERS.map((a) => a.name).join(", ");
  const gateways = Object.keys(loadConfig().gateways).join(", ");
  console.log(`mission-control v${version} - control plane for delegated agent runs

USAGE
  mc <command> [options]

COMMANDS
  run           Launch a tracked, isolated run on a harness
  resume <id>   Continue a run with a follow-up prompt: a new linked run that
                inherits harness/model/auth/artifacts/caps. Default:
                native session resume in the SAME workdir. With --fresh
                [--at SHA]: checkpoint restart - NEW worktree at the commit,
                NEW session (for escaping stuck or degraded sessions).
                Overrides: --artifact (replaces inherited list),
                --max-minutes, --max-idle-minutes, --budget
  reap          Cron-safe: mark dead-supervisor runs lost, deliver pending
                run AND assessment notifications (e.g. */10 * * * * mc reap)
  prune         Reclaim disk from terminal runs' worktrees. Default: dry-run
                report (candidate, status, size). --yes actually removes -
                only worktrees that are CLEAN and whose HEAD is already
                reachable from the source repo's current HEAD (nothing lost);
                everything else (dirty, unmerged, still active) is left
                alone. The run's ledger row and spec survive either way -
                only the checkout itself is reclaimed.
  ls            List runs; also reaps lost runs and re-delivers missed notifications.
                --exit filters by state, comma-separated
                (e.g. --exit running  |  --exit failed,killed,lost)
                --review filters by latest disposition, same syntax
                (e.g. --review pending  |  --review accepted,retry)
  show <id>     Full run record, recent events, and the run's full
                assessment history (oldest first)
                --json      {run, assessments, events} as clean machine-
                            readable JSON: FULL event stream (not last-10),
                            assessments complete with evidence hashes,
                            checkpoint, and delivery state
  tail <id>     Follow a run's event stream until it terminates
  kill <id>     Request termination (state lands when the process actually dies)
  assess <id> --by REVIEWER --disposition accepted|retry|blocked
                Append an attributed review receipt to a TERMINAL run (queued/
                running runs are refused - review begins after the process
                stops). mc validates structure only, never the judgment: any
                disposition is accepted as asserted. Append-only - a
                correction is a NEW row, never an edit of an old one.
                [--at SHA]      Checkpoint the reviewer inspected; verified
                                via git in the run's workdir when it still
                                exists, else accepted as an unverified full SHA
                [--evidence PATH]...
                                Repeatable; mc hashes each file (sha256) at
                                write time, missing file fails loudly
                [--note TEXT]   Free-text context
                Dispatches {topic:"assessment_recorded", run, assessment}
                through [notify.assessment] only - never through [notify].
  harness ls    Adapters: capabilities, install status, live auth probes
  harness check <name> [--gateway G] [--model M]
                Live end-to-end validation against the REAL CLI (costs cents):
                launch, session_id, artifact content, cost/token extraction,
                native resume
  init          Write/merge [notify] and [notify.assessment] into config.toml
                (idempotent; preserves everything else in the file, values
                TOML-escaped so quotes/backslashes round-trip). Every hook
                named verifies itself with a synthetic test push - EVERY
                configured channel (exec and/or webhook) must deliver, not
                just one of them - and exits nonzero if any didn't; init
                never assumes a hook works.
                --notify-exec PATH | --notify-webhook URL
                                Terminal-run push ([notify])
                --assessment-exec PATH | --assessment-webhook URL
                                Assessment-recorded push ([notify.assessment])
                --install-reap  Adds "*/10 * * * * <mc path> reap" to this
                                user's crontab, tagged "# mission-control-reap"
                                (idempotent; remove by hand with crontab -e;
                                embeds MC_HOME= explicitly when this
                                invocation's environment overrides it, since
                                cron jobs don't inherit your shell's env)
  init --check  Read-only: config.toml readability AND parseability (a
                section that failed to parse - e.g. an unterminated quoted
                string - is reported broken, not silently "unconfigured"),
                hook executability, crontab entry presence, a dry test
                dispatch requiring EVERY configured channel to deliver.
                Changes nothing; exits nonzero if anything looks broken.
  help          This page (also: -h, --help anywhere)

RUN OPTIONS
  --harness H       Required. Registered: ${harnesses}
  --model M         Model id; gateway mode needs a provider prefix (moonshotai/kimi-k3)
  --cwd DIR         Git repo to work on; isolated via git worktree (non-git refused)
  --artifact PATH   Declared deliverable, workdir-relative; injected into the
                    prompt as where to write it (repeatable)
  --max-minutes N   Wall-clock cap: kill + notify when exceeded
  --max-idle-minutes N
                    Stall cap: kill when the harness emits nothing on
                    stdout/stderr for N minutes (default 30; 0 disables)
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

STATUS
  exit      queued | running | succeeded | failed | killed | lost
  What the run's process did. A harness that exits 0 but reports a failed
  final turn (pi, confirmed) still lands here as failed, never a false green -
  but exit is a process-completion signal only, not a claim about output
  quality; that judgment is the operator's or orchestrator's to make.

ASSESSMENTS
  review    pending | accepted | retry | blocked   (- for a non-terminal run)
  An attributed, append-only judgment a reviewer records with "mc assess",
  never one mc computes itself. pending_review is the ABSENCE of any
  assessment on a terminal run, not a stored value. mc checks only that an
  "mc assess" call is well-formed (terminal run, valid disposition, --by
  present, evidence files exist) - it never checks whether the judgment
  itself is correct: attribution gives provenance, not trust.

FILES & ENV
  ~/.mission-control/       state root (override: MC_HOME)
    mc.db                   runs + events + assessments (SQLite; any tool can read it)
    runs/<id>/              spec.json, work/, stdout.jsonl, stderr.log
    config.toml             [notify] exec/webhook hooks (terminal runs);
                            [notify.assessment] exec/webhook (assessment
                            receipts - a separate seam, never the same hook);
                            [gateway.NAME] blocks
  MC_CLAUDE_BIN             override the claude binary path (pinning/testing)
  MC_DETECT_TIMEOUT_MS      wall-clock budget for each harness's --version
                            probe (default 10000; raise it if detect()/
                            harness ls falsely reports a slow-but-working
                            CLI as not installed)

EXAMPLES
  mc run --harness claude-code --artifact out/report.md "write the report"
  mc run --harness claude-code --gateway openrouter --model moonshotai/kimi-k3 \\
        --max-minutes 30 --artifact hello.txt "build hello.txt"
  mc ls --json | jq '.[0].exit'
  mc ls --review pending
  mc assess 0h4x --by alice --disposition accepted --evidence out/report.md
  mc init --notify-exec ~/bin/notify.sh --assessment-webhook https://example.com/hook --install-reap
  mc init --check
  mc harness ls

FOR AGENTS
  Driving mc as an orchestrating agent? Read the operating guide first:
  https://raw.githubusercontent.com/gary149/mission-control/main/docs/agents.md`);
}

export async function cliMain(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  const [command, ...args] = argv;

  try {
    switch (command) {
      case "run": {
        const spec = args[0] === "--spec" && args[1] === "-" ? await readSpecFromStdin() : parseRunArgs(args).spec;
        await checkGatewayModelServed(spec, loadConfig());
        const run = launch(spec);
        console.log(`${run.id}  ${run.title}`);
        console.log(`    harness=${run.harness} model=${run.model ?? "(default)"} auth=${run.auth_mode} cost_basis=${run.cost_basis}`);
        console.log(`    workdir=${run.workdir}`);
        console.log(`    mc tail ${run.id}   # follow`);
        break;
      }

      case "ls": {
        // ls takes exactly --json, --exit, and --review; anything else fails
        // loudly. Skipping unknown tokens would turn a misspelled `--exiit
        // running` into an unfiltered SUCCESSFUL response - the worst case
        // for an automated consumer expecting filtered output.
        for (let i = 0; i < args.length; i++) {
          const arg = args[i]!;
          if (arg === "--json") continue;
          if (arg === "--exit" || arg === "--review") {
            i++; // the flag's value; parseExitFilter/parseReviewFilter validates it
            continue;
          }
          fail(`unknown ls argument "${arg}" (valid: --exit, --review, --json)`);
        }
        const exitFilter = parseExitFilter(args);
        const reviewFilter = parseReviewFilter(args);
        // Read command: detect lost runs, but never dispatch/retry delivery
        // (that's `mc reap`'s job) - see reapLostRuns's doc comment. The
        // filters apply AFTER the reap pass so they select on each run's
        // current truth: a stale `running` row that just got reaped shows up
        // under `--exit lost`, not under the state it no longer occupies.
        let runs = await reapLostRuns(listRuns(), false);
        if (exitFilter) runs = runs.filter((r) => exitFilter.has(r.exit));
        if (reviewFilter) runs = runs.filter((r) => reviewFilter.has(reviewStatus(r)));
        if (args.includes("--json")) {
          // --json stays the raw Run[] shape (no bolted-on `review` field):
          // assessments are their own append-only history, not a Run column -
          // `mc show <id>` is where the full assessment history surfaces, the
          // same split as the human table's REVIEW column below vs `mc show`.
          console.log(JSON.stringify(runs, null, 2));
          break;
        }
        if (runs.length === 0) {
          console.log("no runs");
          break;
        }
        const header = ["ID", "TITLE", "HARNESS", "MODEL", "EXIT", "REVIEW", "COST", "TOKENS", "DURATION", "AGE"];
        const rows = runs.map((r) => [
          r.id,
          r.title.slice(0, 40),
          r.harness,
          (r.model ?? "").slice(0, 24),
          r.exit,
          reviewStatus(r),
          r.cost_usd != null ? `$${r.cost_usd.toFixed(2)}` : r.cost_basis === "flat_subscription" ? "plan" : "-",
          tokensCell(r),
          duration(r.started_at, r.ended_at),
          age(r.started_at),
        ]);
        const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
        for (const row of [header, ...rows]) {
          console.log(row.map((cell, i) => cell.padEnd(widths[i]!)).join("  "));
        }
        break;
      }

      case "show": {
        // show takes an id and an optional --json, in either order; any other
        // "--"-prefixed token fails loudly rather than being silently ignored.
        const jsonMode = args.includes("--json");
        for (const arg of args) {
          if (arg !== "--json" && arg.startsWith("--")) fail(`unknown show argument "${arg}" (valid: --json)`);
        }
        const idArg = args.find((a) => a !== "--json");
        // Read command: detect lost runs only, never dispatch/retry delivery.
        const run = (await reapLostRuns([requireRun(idArg)], false))[0]!;
        // Oldest first, full history - never just the latest, per the
        // assessments table's append-only principle (a correction is a new
        // row, and the earlier ones remain part of the record). Computed once
        // and shared by both output modes below.
        const assessments = assessmentsFor(run.id);

        if (jsonMode) {
          // The machine-readable form: run + the assessments' COMPLETE shape
          // (evidence path+sha256, checkpoint_sha, notified delivery state -
          // everything the human form's prose lines below only partially
          // surface) + the FULL event stream, not the human form's
          // abbreviated last-10 - so a script never has to fall back to
          // scraping prose for anything this command knows.
          console.log(JSON.stringify({ run, assessments, events: eventsAfter(run.id, 0) }, null, 2));
          break;
        }

        console.log(JSON.stringify(run, null, 2));
        // Highlighted summary: the JSON above already carries cost_usd/tokens_in/
        // tokens_out/started_at/ended_at, but as ~4 fields among ~20 - and on a
        // long run the final cost_update can scroll out of the 10-event window
        // below. One line keeps "what did this cost" glanceable without a second
        // source of truth (still computed from the same run row, nothing new).
        const cost = run.cost_usd != null ? `$${run.cost_usd.toFixed(2)}` : run.cost_basis === "flat_subscription" ? "plan" : "unavailable";
        console.log(
          `\ncost=${cost}  tokens=${tokensCell(run)}  duration=${duration(run.started_at, run.ended_at)}  review=${reviewStatus(run)}`,
        );
        const recent = eventsAfter(run.id, 0).slice(-10);
        if (recent.length > 0) {
          console.log("\nlast events:");
          for (const event of recent) console.log(`  [${event.seq}] ${event.kind} ${JSON.stringify(event.payload).slice(0, 120)}`);
        }
        if (assessments.length > 0) {
          console.log("\nassessments:");
          for (const a of assessments) {
            const at = a.checkpoint_sha ? ` @${a.checkpoint_sha.slice(0, 7)}` : "";
            const note = a.note ? ` (${a.note})` : "";
            console.log(`  [${a.seq}] ${a.ts} ${a.reviewer} -> ${a.disposition}${at} observed=${a.observed ?? "-"}${note}`);
          }
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
          // frozen `running` row forever. Never dispatch/retry delivery from
          // here though: notifyTerminal's own notify_result event would
          // count as "new" below on every poll, so a permanently-failing
          // hook would keep this loop from ever seeing a quiet poll and it
          // would never break, hammering the hook forever. `mc reap` is the
          // retry path; this is a read command.
          const current = (await reapLostRuns([getRun(run.id)!], false))[0]!;
          if (!["running", "queued"].includes(current.exit) && eventsAfter(run.id, seq).length === 0) {
            console.log(`-- terminal: exit=${current.exit} --`);
            break;
          }
          await sleep(500);
        }
        break;
      }

      case "kill": {
        const requested = requireRun(args[0]);
        // Reap first: a `running` row whose supervisor has already died is
        // exactly the case the ownership check below exists for (nobody's
        // confirmed this pid still belongs to this run), and reaping is
        // what turns it into `lost` - so the same check path covers both a
        // stale `running` row and a genuinely long-lost one.
        const run = (await reapLostRuns([requested]))[0]!;
        // Gate on the harness pid actually being alive, not on exit==="running":
        // a `lost` run (dead supervisor, live harness) is exactly the case
        // nobody else can signal, so it must stay killable through mc.
        const alive = pidAlive(run.pid);
        if (run.exit !== "running" && !(run.exit === "lost" && alive)) {
          fail(`run ${run.id} is not killable (exit=${run.exit}${run.pid ? `, harness pid ${run.pid} ${alive ? "alive" : "already dead"}` : ", no pid recorded"})`);
        }
        // A `lost` row can persist indefinitely before anyone runs `mc kill`
        // on it, so its recorded pid may since have been reused - by an
        // unrelated process, or by a different concurrent run of the same
        // harness. Refuse rather than risk signalling the wrong process.
        if (run.exit === "lost" && run.pid && !looksLikeOwnedProcess(run)) {
          fail(`pid ${run.pid} is not run ${run.id}'s harness (start time mismatch, PID reuse); refusing`);
        }
        // Durable intent BEFORE signalling: even if the harness traps SIGTERM
        // and exits 0, or the escalation below has to wait out the full
        // timeout, this event is already on the ledger so a killed run is
        // never mislabeled succeeded.
        insertEvent(run.id, "status_change", { kill_requested: true, by: "mc kill" });
        if (run.pid) {
          await killWithEscalation(run.pid);
        }
        console.log(`kill requested for ${run.id} (mc tail ${run.id} to watch it land)`);
        break;
      }

      case "resume": {
        const parent = requireRun(args[0]);
        // A continuation inherits the parent's archived spec - harness/model/
        // auth/artifacts/caps - unless explicitly overridden, so a follow-up
        // never silently drops what the parent declared.
        const parentStored = JSON.parse(readFileSync(parent.spec_path, "utf8"));
        let maxMinutes: number | null | undefined;
        let maxIdleMinutes: number | null | undefined;
        let budget: number | null | undefined;
        let fresh = false;
        let at: string | undefined;
        const artifacts: string[] = [];
        const positional: string[] = [];
        for (let i = 1; i < args.length; i++) {
          const arg = args[i]!;
          const next = () => {
            const value = args[++i];
            if (value === undefined) fail(`${arg} requires a value`);
            return value;
          };
          const nextPositive = () => {
            const value = Number(next());
            if (!Number.isFinite(value) || value <= 0) fail(`${arg} must be a finite positive number`);
            return value;
          };
          const nextNonNegative = () => {
            const value = Number(next());
            if (!Number.isFinite(value) || value < 0) fail(`${arg} must be a finite number >= 0 (0 disables)`);
            return value;
          };
          switch (arg) {
            case "--artifact": artifacts.push(next()); break;
            case "--max-minutes": maxMinutes = nextPositive(); break;
            case "--max-idle-minutes": maxIdleMinutes = nextNonNegative(); break;
            case "--budget": budget = nextPositive(); break;
            case "--fresh": fresh = true; break;
            case "--at": at = next(); break;
            default:
              if (arg.startsWith("--")) fail(`unknown flag ${arg} (resume inherits spec fields from the parent)`);
              positional.push(arg);
          }
        }
        if (at && !fresh) fail("--at requires --fresh (a native resume continues the session where it is)");
        const prompt = positional.join(" ").trim();
        if (!prompt) fail("a follow-up prompt is required");
        const run = launch(
          {
            harness: parent.harness,
            model: parent.model,
            prompt,
            cwd: null,
            artifacts: artifacts.length > 0 ? artifacts : (parentStored.artifacts ?? []),
            budget_usd: budget !== undefined ? budget : (parentStored.budget_usd ?? null),
            max_minutes: maxMinutes !== undefined ? maxMinutes : (parentStored.max_minutes ?? null),
            max_idle_minutes: maxIdleMinutes !== undefined ? maxIdleMinutes : (parentStored.max_idle_minutes ?? null),
            auth: parentStored.auth ?? { mode: "subscription" },
          },
          { parent, fresh, at },
        );
        console.log(`${run.id}  ${run.title}`);
        if (fresh) {
          console.log(`    fresh restart of ${parent.id} from checkpoint${at ? ` ${at}` : " (parent HEAD)"} in ${run.workdir}`);
        } else {
          console.log(`    resumes ${parent.id} (session ${parent.session_id}) in ${run.workdir}`);
        }
        console.log(`    mc tail ${run.id}   # follow`);
        break;
      }

      case "assess": {
        const id = args[0];
        if (!id) {
          fail(
            "usage: mc assess <id> --by REVIEWER --disposition accepted|retry|blocked [--at SHA] [--evidence PATH]... [--note TEXT]",
          );
        }
        let reviewer: string | null = null;
        let disposition: string | null = null;
        let at: string | null = null;
        let note: string | null = null;
        const evidencePaths: string[] = [];
        for (let i = 1; i < args.length; i++) {
          const arg = args[i]!;
          const next = () => {
            const value = args[++i];
            if (value === undefined) fail(`${arg} requires a value`);
            return value;
          };
          switch (arg) {
            case "--by": reviewer = next(); break;
            case "--disposition": disposition = next(); break;
            case "--at": at = next(); break;
            case "--evidence": evidencePaths.push(next()); break;
            case "--note": note = next(); break;
            default: fail(`unknown flag ${arg}`);
          }
        }
        // reviewer is an ASSERTED identity (see db.ts's assessments table
        // comment) - mandatory, and never defaulted to the OS user or
        // anything else. Defaulting it would quietly convert "who is
        // claiming this" into "whoever happened to run the command". Trim
        // before checking: a whitespace-only value ("--by '   '") is not an
        // identity either - the pre-trim falsiness check alone let it through
        // (a non-empty string is truthy regardless of what's in it), and the
        // trimmed value is also what gets stored, so " alice " and "alice"
        // aren't silently treated as different reviewers. db.ts's CHECK
        // constraint (length(trim(reviewer)) > 0) enforces the same rule at
        // the schema level as defense in depth.
        reviewer = reviewer?.trim() ?? null;
        if (!reviewer) fail("--by is required (reviewer identity is never defaulted)");
        if (!disposition || !DISPOSITION_VALUES.includes(disposition)) {
          fail(`--disposition is required, one of: ${DISPOSITION_VALUES.join(", ")}`);
        }

        const run = requireRun(id);
        // Review begins after the process stops: mc validates structure, not
        // the judgment, but a still-queued/running run has no terminal state
        // yet for a reviewer to be attributing a judgment to.
        if (isActive(run)) {
          fail(`run ${run.id} is not terminal yet (exit=${run.exit}); review begins after the process stops`);
        }

        // --evidence: repeatable file paths: mc computes and stores sha256 of
        // each existing file, never the content itself. A missing file fails
        // loudly rather than silently recording a broken reference.
        const evidence = evidencePaths.map((p) => {
          if (!existsSync(p)) fail(`--evidence file not found: ${p}`);
          const sha256 = createHash("sha256").update(readFileSync(p)).digest("hex");
          return { path: p, sha256 };
        });

        let checkpointSha: string | null = null;
        let unverifiedNote: string | null = null;
        if (at) {
          const workdirIsGit =
            existsSync(run.workdir) &&
            spawnSync("git", ["-C", run.workdir, "rev-parse", "--git-dir"], { stdio: "ignore" }).status === 0;
          if (workdirIsGit) {
            const verify = spawnSync("git", ["-C", run.workdir, "rev-parse", "--verify", `${at}^{commit}`], {
              encoding: "utf8",
            });
            if (verify.status !== 0) fail(`--at ${at} does not resolve to a commit in ${run.workdir}`);
            checkpointSha = verify.stdout.trim();
          } else {
            // The run's worktree is gone (pruned, or never existed) - there is
            // no git to verify against. Accept a full 40-char hex SHA as-is
            // rather than refuse outright, but the record must say the SHA
            // was never actually checked.
            if (!/^[0-9a-f]{40}$/i.test(at)) {
              fail(`--at must be a full 40-char hex SHA when the run's workdir is gone (got "${at}")`);
            }
            checkpointSha = at.toLowerCase();
            unverifiedNote = "checkpoint SHA unverified: run workdir is gone";
          }
        }
        const finalNote = note && unverifiedNote ? `${note} [${unverifiedNote}]` : (note ?? unverifiedNote);

        // What mc itself observed while recording this - independent of, and
        // never substituted for, the asserted `reviewer` identity above.
        const observed = `${userInfo().username}@${hostname()}`;

        const assessment = insertAssessment(run.id, {
          reviewer,
          disposition,
          checkpoint_sha: checkpointSha,
          evidence,
          note: finalNote,
          observed,
        });
        console.log(JSON.stringify(assessment, null, 2));

        // Separate seam from [notify] - see notify.ts's notifyAssessment for
        // why an assessment payload must never reach the terminal-run hook.
        await notifyAssessment(run, assessment, loadConfig());
        break;
      }

      case "reap": {
        // Cron-safe lost-run detection + at-least-once notification delivery:
        // the push half of the system must not depend on anyone running `mc
        // ls`/`show`/`tail` - those read commands deliberately do NOT
        // dispatch or retry delivery (see reapLostRuns's doc comment). This
        // is the one place besides the supervisor's own terminal dispatch
        // that does.
        const before = listRuns();
        const activeIds = new Set(before.filter(isActive).map((r) => r.id));
        const unnotified = new Set(before.filter((r) => !isActive(r) && !r.notified).map((r) => r.id));
        const after = await reapLostRuns(before, true);
        const lost = after.filter((r) => r.exit === "lost" && activeIds.has(r.id)).length;
        // "settled": the delivery obligation was discharged - a channel
        // delivered, or none were configured. Not a claim of guaranteed
        // external receipt (a failed hook leaves notified=false for retry).
        const settled = after.filter((r) => r.notified && (unnotified.has(r.id) || (activeIds.has(r.id) && r.exit === "lost"))).length;

        // Assessment notifications are a separate delivery seam and their own
        // table ([notify.assessment] / assessments.notified) - retried here
        // the same way undelivered run notifications are retried above.
        const pendingAssessments = unnotifiedAssessments();
        if (pendingAssessments.length > 0) {
          const config = loadConfig();
          for (const a of pendingAssessments) {
            const assessedRun = getRun(a.run_id);
            if (assessedRun) await notifyAssessment(assessedRun, a, config);
          }
        }
        const assessmentsSettled = pendingAssessments.length - unnotifiedAssessments().length;

        console.log(
          `reaped ${lost} lost run(s), settled ${settled} notification(s), settled ${assessmentsSettled} assessment notification(s)`,
        );
        break;
      }

      case "prune": {
        for (const arg of args) {
          if (arg !== "--yes" && arg !== "--json") fail(`unknown prune argument "${arg}" (valid: --yes, --json)`);
        }
        const yes = args.includes("--yes");
        const candidates = listRuns().map(evaluateWorktree);
        const safe = candidates.filter((c) => c.status === "safe");
        const results = yes
          ? safe.map((c) => ({ ...c, result: pruneWorktree(c) }))
          : safe.map((c) => ({ ...c, result: undefined }));
        if (args.includes("--json")) {
          console.log(
            JSON.stringify(
              candidates.map((c) => ({
                id: c.run.id,
                status: c.status,
                size_bytes: c.sizeBytes,
                detail: c.detail,
                removed: results.find((r) => r.run.id === c.run.id)?.result?.removed ?? null,
              })),
              null,
              2,
            ),
          );
          break;
        }
        const relevant = candidates.filter((c) => c.status !== "active" && c.status !== "missing");
        if (relevant.length === 0) {
          console.log("nothing to prune");
          break;
        }
        for (const c of relevant) {
          const size = c.sizeBytes != null ? formatBytes(c.sizeBytes) : "-";
          const acted = yes ? results.find((r) => r.run.id === c.run.id)?.result : undefined;
          const mark = acted ? (acted.removed ? "removed" : `FAILED: ${acted.error}`) : c.status;
          console.log(`${c.run.id}  ${mark.padEnd(9)}  ${size.padStart(7)}  ${c.detail}`);
        }
        const totalSafeBytes = safe.reduce((sum, c) => sum + (c.sizeBytes ?? 0), 0);
        if (yes) {
          const removed = results.filter((r) => r.result?.removed).length;
          console.log(`\nreclaimed ${removed}/${safe.length} worktree(s), ~${formatBytes(totalSafeBytes)}`);
        } else if (safe.length > 0) {
          console.log(`\n${safe.length} safe to prune, ~${formatBytes(totalSafeBytes)} reclaimable. Run \`mc prune --yes\` to reclaim.`);
        }
        break;
      }

      case "harness": {
        if (args[0] === "check") {
          await harnessCheck(args.slice(1));
          break;
        }
        if (args[0] !== "ls") fail("usage: mc harness ls | mc harness check <name> [--gateway NAME] [--model M]");
        const config = loadConfig();
        for (const adapter of ADAPTERS) {
          const detection = adapter.detect();
          console.log(`${adapter.name}`);
          console.log(`  installed: ${detection.installed ? `yes (${detection.path}, ${detection.version ?? "?"})` : "no"}`);
          console.log(`  capabilities: ${JSON.stringify(adapter.capabilities)}`);
          for (const mode of adapter.capabilities.auth_modes) {
            let probe: string;
            try {
              const spec: RunSpec = {
                // kimi-code requires a model in every mode; give the probe one so
                // it reports credential readiness, not the model requirement.
                harness: adapter.name, model: mode === "gateway" || adapter.name === "kimi-code" ? "probe/probe" : null, prompt: "probe",
                cwd: null, artifacts: [], budget_usd: null, max_minutes: null, max_idle_minutes: null,
                auth: mode === "gateway" ? { mode, gateway: "openrouter" } : { mode },
              };
              const resolved = resolveAuth(spec, adapter, config);
              probe = `ready (${resolved.source})`;
            } catch (error) {
              probe = error instanceof PreflightError ? `missing (${error.message.split(";")[0]})` : "error";
            }
            console.log(`  auth ${mode}: ${probe}`);
          }
        }
        break;
      }

      case "init":
        // `mc init --check` is read-only diagnosis; every other form writes
        // config.toml (idempotently) and optionally the crontab reap entry.
        // Flag/value parsing and validation live in runInit itself.
        await runInit(args);
        break;

      case "help":
      case undefined:
        printHelp();
        break;

      default:
        fail(`unknown command "${command}" (try: mc help)`);
    }
  } catch (error) {
    if (error instanceof PreflightError) fail(error.message);
    throw error;
  }
}

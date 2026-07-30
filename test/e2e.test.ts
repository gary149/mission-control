import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const FIXTURE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const FIXTURE_KIMI = fileURLToPath(new URL("./fixtures/fake-kimi.mjs", import.meta.url));
const FIXTURE_OPENCODE = fileURLToPath(new URL("./fixtures/fake-opencode.mjs", import.meta.url));
const FIXTURE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

let home: string;

async function waitTerminal(getRun: () => any, timeoutMs = 20000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const run = getRun();
    if (run && !["queued", "running"].includes(run.exit)) return run;
    if (Date.now() - start > timeoutMs) throw new Error(`run did not terminate: ${JSON.stringify(run)}`);
    await sleep(200);
  }
}

/** Poll until the supervisor has spawned the harness and recorded its pid. */
async function waitRunning(getRun: () => any, timeoutMs = 10000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const run = getRun();
    if (run && run.exit === "running" && run.pid) return run;
    if (Date.now() - start > timeoutMs) throw new Error(`run never reached running with a pid: ${JSON.stringify(run)}`);
    await sleep(100);
  }
}

/** Mirrors cli.ts's pidAlive (not exported); used by tests to assert no orphan survives a kill. */
function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Mirrors supervisor.ts/cli.ts's pidStart (not exported); used to fabricate a matching (or deliberately mismatched) `pid_start`. */
function psLstart(pid: number): string {
  return spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
}

/**
 * Run `mc <args>` asynchronously (not spawnSync). When a test is itself the
 * parent of a fabricated orphan process (see the "lost-but-alive" kill test),
 * spawnSync blocks this process's whole event loop for as long as the child
 * runs, which prevents it from reaping the orphan's zombie once the group
 * signal lands - a self-inflicted artifact of the test harness, not
 * something a real caller (an unrelated shell/orchestrator) ever hits.
 */
function runMc(entry: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** notified.json is rewritten per terminal run; poll until it carries this id. */
async function notifiedFor(id: string, timeoutMs = 5000): Promise<any> {
  const start = Date.now();
  for (;;) {
    try {
      const payload = JSON.parse(readFileSync(join(home, "notified.json"), "utf8"));
      if (payload.id === id) return payload;
    } catch {
      /* not written yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`notified.json never carried ${id}`);
    await sleep(100);
  }
}

/** No error-kind event of any kind reached the ledger for this run - the
 * adapter treated everything it saw as either a mapped event or (for a
 * genuine harness failure) a clean harness-error, never an unparsed/
 * unknown-native-event drift signal. */
function hasNoErrorEvents(eventsAfter: (id: string, seq: number) => any[], runId: string): boolean {
  return !eventsAfter(runId, 0).some((e: any) => e.kind === "error");
}

function baseSpec(overrides: Record<string, unknown>) {
  return {
    harness: "claude-code",
    model: null,
    prompt: "test prompt",
    cwd: null,
    artifacts: [] as string[],
    budget_usd: null,
    max_minutes: null,
    auth: { mode: "api_key" as const },
    ...overrides,
  };
}

describe("mission-control e2e (stub harness)", () => {
  before(() => {
    home = mkdtempSync(join(tmpdir(), "mc-test-"));
    process.env.MC_HOME = home;
    process.env.MC_CLAUDE_BIN = FIXTURE;
    process.env.MC_CODEX_BIN = FIXTURE_CODEX;
    process.env.MC_KIMI_BIN = FIXTURE_KIMI;
    process.env.MC_OPENCODE_BIN = FIXTURE_OPENCODE;
    process.env.MC_PI_BIN = FIXTURE_PI;
    process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
    // Poison: resident on the host, must never reach a child (additive-from-empty env).
    process.env.OPENROUTER_API_KEY = "or-poison-not-real";
    process.env.HF_TOKEN = "hf-poison-not-real";
    for (const fixture of [FIXTURE, FIXTURE_CODEX, FIXTURE_KIMI, FIXTURE_OPENCODE, FIXTURE_PI]) chmodSync(fixture, 0o755);
    // Notify hook writes its payload to a file we can assert on.
    writeFileSync(join(home, "config.toml"), `[notify]\nexec = "cat > ${home}/notified.json"\n`);
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("run -> succeeded -> notified, with cost and clean child env", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");

    const envDump = join(home, "child-env.json");
    const run = launch(
      baseSpec({
        prompt: `produce out.txt for the e2e test DUMPENV:${envDump}`,
        artifacts: ["out.txt"],
      }) as never,
    );
    assert.equal(run.cost_basis, "metered_reported");

    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "succeeded");
    assert.ok(done.supervisor_pid > 0);
    assert.equal(done.cost_usd, 0.42);
    assert.equal(done.tokens_in, 1000);
    assert.equal(done.tokens_out, 250);
    assert.equal(done.session_id, "fake-session-123");
    assert.ok(existsSync(join(done.workdir, "out.txt")));

    // Event stream has the normalized shape. The terminal ROW lands before
    // the supervisor's notify dispatch records its notify_result event, so
    // waitTerminal alone can race the last milliseconds of delivery under
    // load - poll briefly for notify_result before asserting on the stream.
    let events = eventsAfter(run.id, 0);
    for (let i = 0; i < 40 && !events.some((e: any) => e.kind === "notify_result"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      events = eventsAfter(run.id, 0);
    }
    const kinds = events.map((e: any) => e.kind);
    for (const expected of ["started", "text", "tool_call", "subagent", "cost_update", "notify_result", "exited"]) {
      assert.ok(kinds.includes(expected), `missing event kind ${expected} in ${kinds}`);
    }
    // A clean run synthesizes nothing: no error events of any kind. The
    // fixture also emits a real tool_progress heartbeat (long-running Bash/
    // Read/WebFetch/TaskOutput calls) - a TOP-LEVEL type the adapter must
    // treat as benign, or this assertion would fail.
    assert.ok(!kinds.includes("error"), `unexpected error events in ${kinds}`);

    // Subagent lifecycle (system subtypes) maps to STRUCTURED events, never to
    // errors, and the payloads carry the ids/descriptions an orchestrator
    // renders from.
    const subagent = events.filter((e: any) => e.kind === "subagent").map((e: any) => e.payload as any);
    assert.equal(subagent.length, 5);
    assert.deepEqual(
      subagent.map((p) => p.phase),
      ["task_started", "task_progress", "task_updated", "task_notification", "background_tasks_changed"],
    );
    assert.equal(subagent[0].task_id, "bc8l380mx");
    assert.equal(subagent[0].description, "Probe candidate fire data and basemap endpoints");
    assert.equal(subagent[2].status, "failed"); // task_updated carries patch.status
    assert.equal(subagent[3].status, "completed");
    assert.equal(subagent[4].tasks[0].task_id, "wtga1fo90");

    // Notification fired with exit and no credential plumbing.
    const payload = JSON.parse(readFileSync(join(home, "notified.json"), "utf8"));
    assert.equal(payload.id, run.id);
    assert.equal(payload.exit, "succeeded");
    assert.equal(payload.auth_mode, "api_key");
    assert.equal(payload.gateway, undefined);

    // Env poisoning: the child got the one forwarded key and none of the residents.
    const childEnv = JSON.parse(readFileSync(envDump, "utf8"));
    assert.equal(childEnv.ANTHROPIC_API_KEY, "sk-test-not-real");
    assert.equal(childEnv.OPENROUTER_API_KEY, undefined);
    assert.equal(childEnv.HF_TOKEN, undefined);
    assert.equal(childEnv.DISABLE_AUTOUPDATER, "1");
  });

  test("failing run -> failed, secrets scrubbed from logs", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");

    const run = launch(baseSpec({ prompt: "fail on purpose FAIL LEAK", artifacts: ["out.txt"] }) as never);
    const done = await waitTerminal(() => getRun(run.id));

    assert.equal(done.exit, "failed");

    // The failure REASON is a readable harness-error event, not a buried boolean.
    const err = eventsAfter(run.id, 0).find((e: any) => e.kind === "error" && (e.payload as any)?.note === "harness-error");
    assert.ok(err, "missing harness-error event for a failed claude-code run");
    assert.ok(String((err!.payload as any).message).includes("error_during_execution"));

    // ...and the notify payload carries the why, not just the fact.
    const payload = await notifiedFor(run.id);
    assert.equal(payload.exit_code, 1);
    assert.ok(String(payload.error).includes("error_during_execution"));

    // The injected key was echoed to stderr by the CLI; the stored log must be scrubbed.
    const stderrLog = readFileSync(done.stderr_path, "utf8");
    assert.ok(stderrLog.includes("***"));
    assert.ok(!stderrLog.includes("sk-test-not-real"));
  });

  test("preflight refuses --budget with adapter-correct advice in every mode", async () => {
    const { launch } = await import("../src/core/launch.ts");

    // The claude-code-specific refusal fires first so the user is pointed at
    // --max-minutes directly, never bounced to --api-key (which also refuses).
    assert.throws(
      () =>
        launch(
          baseSpec({
            model: "moonshotai/kimi-k3",
            budget_usd: 5,
            auth: { mode: "gateway", gateway: "openrouter" },
          }) as never,
        ),
      /cannot be enforced[\s\S]*--max-minutes/,
    );
  });

  test("help covers every command and flag, and -h never launches a run", async () => {
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));
    const help = spawnSync(process.execPath, [entry, "help"], { encoding: "utf8", env: { ...process.env } }).stdout;
    for (const expected of [
      "run", "ls", "show", "tail", "kill", "harness ls", "resume", "reap",
      "--harness", "--model", "--cwd", "--artifact",
      "--max-minutes", "--budget", "--gateway", "--api-key", "--spec",
      "--fresh", "--at SHA", "--max-idle-minutes",
      "subscription", "MC_HOME", "config.toml",
    ]) {
      assert.ok(help.includes(expected), `help is missing "${expected}"`);
    }
    // `mc run -h` must print help, not launch a run with prompt "-h".
    const runH = spawnSync(process.execPath, [entry, "run", "-h"], { encoding: "utf8", env: { ...process.env } });
    assert.ok(runH.stdout.includes("USAGE"));
    assert.equal(runH.status, 0);
  });

  test("codex: succeeded run, tokens without cost, scratch CODEX_HOME, clean env", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");
    process.env.OPENAI_API_KEY = "sk-codex-test-not-real";

    const envDump = join(home, "codex-env.json");
    const run = launch(
      baseSpec({
        harness: "codex",
        prompt: `produce out.txt DUMPENV:${envDump}`,
        artifacts: ["out.txt"],
        auth: { mode: "api_key" },
      }) as never,
    );
    assert.equal(run.cost_basis, "unavailable");
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "succeeded");
    assert.equal(done.session_id, "fake-thread-0001");
    assert.equal(done.tokens_in, 500);
    assert.equal(done.tokens_out, 80);
    assert.equal(done.cost_usd, null); // codex never reports dollars, any mode

    const childEnv = JSON.parse(readFileSync(envDump, "utf8"));
    assert.equal(childEnv.OPENAI_API_KEY, "sk-codex-test-not-real");
    assert.ok(childEnv.CODEX_HOME.includes("/codex-home")); // scratch, never ~/.codex
    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(childEnv.OPENROUTER_API_KEY, undefined);
  });

  test("codex: --budget refused (no cost signal in any mode)", async () => {
    const { launch } = await import("../src/core/launch.ts");
    assert.throws(
      () => launch(baseSpec({ harness: "codex", budget_usd: 5, auth: { mode: "api_key" } }) as never),
      /--budget has no meaning/,
    );
  });

  test("pi: succeeded run with ACCUMULATED per-turn cost and tokens (gateway mode)", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");

    const envDump = join(home, "pi-env.json");
    const run = launch(
      baseSpec({
        harness: "pi",
        model: "fake/model",
        prompt: `produce out.txt DUMPENV:${envDump}`,
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    assert.equal(run.cost_basis, "metered_reported");
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "succeeded");
    // The fixture emits tool_execution_update (real pi progress noise) - if
    // the adapter mishandled it, it would have surfaced as an error event.
    assert.ok(hasNoErrorEvents(eventsAfter, run.id), "pi streaming progress events must not produce error events");
    assert.equal(done.session_id, "019f0000-fake-7000-a000-000000000001");
    // Two turns at 0.001 each and (2000+1000)/(20+30) tokens - deltas must SUM.
    assert.ok(Math.abs(done.cost_usd - 0.002) < 1e-5, `cost_usd ${done.cost_usd} != ~0.002`);
    assert.equal(done.tokens_in, 3000);
    assert.equal(done.tokens_out, 50);

    const childEnv = JSON.parse(readFileSync(envDump, "utf8"));
    assert.equal(childEnv.OPENROUTER_API_KEY, "or-poison-not-real"); // forwarded: it IS the gateway credential
    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(childEnv.HF_TOKEN, undefined);
  });

  test("pi: --budget is enforceable mid-run (killed between turns on overspend)", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");

    const run = launch(
      baseSpec({
        harness: "pi",
        model: "fake/model",
        prompt: "spend too much OVERBUDGET",
        artifacts: ["out.txt"],
        budget_usd: 1,
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "killed");
    const capEvents = eventsAfter(run.id, 0).filter(
      (e: any) => e.kind === "error" && (e.payload as any)?.note === "cap-exceeded",
    );
    assert.equal(capEvents.length, 1);
    assert.ok(String((capEvents[0]!.payload as any).detail).includes("budget"));
  });

  test("stall detection: a silent harness is killed at the idle cap", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");

    // SLEEP:8000 = the fixture emits its opening events then goes silent long
    // past the 0.03m (1.8s) idle cap; the watchdog must kill it, not wait.
    const run = launch(
      baseSpec({ prompt: "hang silently SLEEP:8000", artifacts: ["out.txt"], max_idle_minutes: 0.03 }) as never,
    );
    assert.equal(run.max_idle_minutes, 0.03);
    const done = await waitTerminal(() => getRun(run.id), 30000);
    assert.equal(done.exit, "killed");
    const capEvents = eventsAfter(run.id, 0).filter(
      (e: any) => e.kind === "error" && (e.payload as any)?.note === "cap-exceeded",
    );
    assert.equal(capEvents.length, 1);
    assert.ok(String((capEvents[0]!.payload as any).detail).includes("max_idle_minutes"));
    // The stall reason reaches the notify payload like any other cap kill.
    const payload = await notifiedFor(run.id);
    assert.ok(String(payload.error).includes("max_idle_minutes"));
  });

  test("pi: subscription without a provider-prefixed model is refused (env-dependent defaults)", async () => {
    const { launch } = await import("../src/core/launch.ts");
    // Locally: the model-requirement error. CI (no ~/.pi): the no-login error. Both fail closed.
    assert.throws(
      () => launch(baseSpec({ harness: "pi", auth: { mode: "subscription" } }) as never),
      /pi requires --model|no resident pi login/,
    );
  });

  test("pi: harness-reported failure lands failed with a clean parse", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");

    const run = launch(
      baseSpec({
        harness: "pi",
        model: "fake/model",
        prompt: "fail on purpose FAIL",
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "failed");
    const err = eventsAfter(run.id, 0).find((e: any) => e.kind === "error" && (e.payload as any)?.note === "harness-error");
    assert.ok(err, "missing harness-error event for a failed pi run");
    // A cleanly parsed harness failure is still a parse: no unparsed/unknown
    // drift events alongside the expected harness-error.
    const driftEvents = eventsAfter(run.id, 0).filter(
      (e: any) => e.kind === "error" && (e.payload as any)?.note === "unknown-native-event",
    );
    assert.equal(driftEvents.length, 0, "a cleanly parsed pi failure must not also produce drift events");
  });

  test("pi: SOFTFAIL (errored terminal turn, process exit 0) is NOT a false green, even with an artifact present", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

    // pi's real shape (print-mode.js, `--mode json`): the process exits 0
    // even when the final assistant message has stopReason "error". A naive
    // exit-code-only classification would call this `succeeded`.
    const run = launch(
      baseSpec({
        harness: "pi",
        model: "fake/model",
        prompt: "produce out.txt then fail softly SOFTFAIL",
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    const done = await waitTerminal(() => getRun(run.id));
    assert.ok(existsSync(join(done.workdir, "out.txt")), "fixture must actually write the artifact");
    assert.equal(done.exit, "failed");
  });

  test("pi: ABORTFAIL (stopReason aborted) fails the same way, and usage from the aborted turn is still recorded", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

    const run = launch(
      baseSpec({
        harness: "pi",
        model: "fake/model",
        prompt: "produce out.txt then abort ABORTFAIL",
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "failed");
    // The `usage` object is required on error/aborted terminal messages too -
    // dropping it would silently understate cost/tokens and starve --budget
    // enforcement on the run's way out.
    assert.equal(done.tokens_in, 300);
    assert.equal(done.tokens_out, 7);
    assert.ok(done.cost_usd != null && Math.abs(done.cost_usd - 0.001) < 1e-6, `cost_usd ${done.cost_usd} != ~0.001`);
  });

  test("pi: real-but-unmapped session events (compaction, auto-retry, queue) produce no error events and reach succeeded", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");

    const run = launch(
      baseSpec({
        harness: "pi",
        model: "fake/model",
        prompt: "produce out.txt NOISYEVENTS",
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "succeeded");
    assert.ok(
      hasNoErrorEvents(eventsAfter, run.id),
      "queue_update/compaction_start/compaction_end/auto_retry_* must not produce error events",
    );
  });

  test("pi: api_key mode refused with an honest rationale", async () => {
    const { launch } = await import("../src/core/launch.ts");
    assert.throws(
      () => launch(baseSpec({ harness: "pi", auth: { mode: "api_key" } }) as never),
      /does not support auth mode "api_key"[\s\S]*auth\.json/,
    );
  });

  test("kimi-code: succeeded run via gateway; session captured from the trailing resume_hint", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");

    const envDump = join(home, "kimi-env.json");
    const run = launch(
      baseSpec({
        harness: "kimi-code",
        model: "moonshotai/kimi-k3",
        prompt: `produce out.txt DUMPENV:${envDump}`,
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    assert.equal(run.cost_basis, "unavailable");
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "succeeded");
    // The stream has NO token/cost telemetry - null, never zero or invented.
    assert.equal(done.cost_usd, null);
    assert.equal(done.tokens_in, null);
    assert.equal(done.tokens_out, null);
    // session_id arrives only in the trailing resume_hint meta line, and the
    // retry meta noise the fixture leads with must not produce error events.
    assert.equal(done.session_id, "session_fake0000-f0a6-4d76-811d-35e6a1e7559e");
    assert.ok(hasNoErrorEvents(eventsAfter, run.id), "kimi meta noise must not produce error events");

    // The gateway credential reaches the child ONLY as KIMI_MODEL_API_KEY (the
    // one env channel kimi reads); nothing else leaks.
    const childEnv = JSON.parse(readFileSync(envDump, "utf8"));
    assert.equal(childEnv.KIMI_MODEL_API_KEY, "or-poison-not-real");
    assert.equal(childEnv.KIMI_MODEL_PROVIDER_TYPE, "openai");
    assert.equal(childEnv.KIMI_MODEL_BASE_URL, "https://openrouter.ai/api/v1");
    assert.equal(childEnv.KIMI_MODEL_NAME, "moonshotai/kimi-k3");
    assert.ok(String(childEnv.KIMI_CODE_HOME).endsWith("/kimi-home"));
    assert.equal(childEnv.OPENROUTER_API_KEY, undefined);
    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(childEnv.HF_TOKEN, undefined);
  });

  test("kimi-code: failed run (empty stdout, exit 1) lands failed", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

    const run = launch(
      baseSpec({
        harness: "kimi-code",
        model: "moonshotai/kimi-k3",
        prompt: "fail on purpose FAIL",
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "failed");

    // Empty stdout means no harness-error event - the supervisor synthesizes
    // the reason from the scrubbed stderr tail so the failure is not silent.
    const { eventsAfter } = await import("../src/core/db.ts");
    const tail = eventsAfter(run.id, 0).find((e: any) => e.kind === "error" && (e.payload as any)?.note === "stderr-tail");
    assert.ok(tail, "missing synthesized stderr-tail event");
    assert.ok(String((tail!.payload as any).excerpt).includes("simulated failure"));
    const payload = await notifiedFor(run.id);
    assert.ok(String(payload.error).includes("simulated failure"));
  });

  test("kimi-code: native resume via --session continues the same session", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

    const parentRun = launch(
      baseSpec({
        harness: "kimi-code",
        model: "moonshotai/kimi-k3",
        prompt: "first step: produce out.txt",
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    const parent = await waitTerminal(() => getRun(parentRun.id));
    assert.equal(parent.session_id, "session_fake0000-f0a6-4d76-811d-35e6a1e7559e");

    const resumed = launch(
      baseSpec({
        harness: "kimi-code",
        model: "moonshotai/kimi-k3",
        prompt: "second step: append",
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
      { parent },
    );
    const resumedDone = await waitTerminal(() => getRun(resumed.id));
    assert.equal(resumedDone.exit, "succeeded");
    assert.equal(resumedDone.session_id, parent.session_id); // same id re-emitted on resume
    const content = readFileSync(join(parent.workdir, "out.txt"), "utf8");
    assert.ok(content.includes("resumed OK")); // the fake appends only under --session
  });

  test("kimi-code: --budget refused (no cost telemetry in any mode)", async () => {
    const { launch } = await import("../src/core/launch.ts");
    assert.throws(
      () =>
        launch(
          baseSpec({
            harness: "kimi-code",
            model: "moonshotai/kimi-k3",
            budget_usd: 1,
            auth: { mode: "gateway", gateway: "openrouter" },
          }) as never,
        ),
      /--budget has no meaning for kimi-code/,
    );
  });

  test("kimi-code: model is required (no default_model in the scratch home)", async () => {
    const { launch } = await import("../src/core/launch.ts");
    assert.throws(
      () => launch(baseSpec({ harness: "kimi-code", auth: { mode: "api_key" } }) as never),
      /kimi-code requires --model/,
    );
  });

  test("kimi-code: subscription refused by capability declaration", async () => {
    const { launch } = await import("../src/core/launch.ts");
    assert.throws(
      () =>
        launch(
          baseSpec({ harness: "kimi-code", model: "kimi-for-coding", auth: { mode: "subscription" } }) as never,
        ),
      /does not support auth mode "subscription"/,
    );
  });

  test("opencode: succeeded gateway run; metered per-step cost and tokens ACCUMULATE", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");

    const envDump = join(home, "opencode-env.json");
    const run = launch(
      baseSpec({
        harness: "opencode",
        model: "moonshotai/kimi-k3",
        prompt: `produce out.txt DUMPENV:${envDump}`,
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    // Probed live: step_finish.cost is a sane per-step delta on the openrouter
    // path, so gateway mode is genuinely metered (unlike subscription).
    assert.equal(run.cost_basis, "metered_reported");
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "succeeded");
    assert.equal(done.session_id, "ses_fake05772ffeXi7yksg5cygHR7");
    // Two steps: 6477+621 in, 76+27 out, 0.0216654+0.0055986 dollars - deltas SUM.
    assert.equal(done.tokens_in, 7098);
    assert.equal(done.tokens_out, 103);
    assert.ok(Math.abs(done.cost_usd - 0.027264) < 1e-6, `cost_usd ${done.cost_usd} != ~0.027264`);
    assert.ok(hasNoErrorEvents(eventsAfter, run.id), "step_start noise must not produce error events");

    // Full XDG isolation + exactly one credential, delivered under the name
    // opencode actually reads (OPENROUTER_API_KEY); nothing else leaks.
    const childEnv = JSON.parse(readFileSync(envDump, "utf8"));
    assert.equal(childEnv.OPENROUTER_API_KEY, "or-poison-not-real");
    assert.equal(childEnv.OPENCODE_DISABLE_AUTOUPDATE, "1");
    for (const v of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
      assert.ok(String(childEnv[v]).includes("/opencode-home/"), `${v} not under scratch opencode-home`);
    }
    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(childEnv.HF_TOKEN, undefined);
  });

  test("opencode: mid-stream FAIL lands failed with a clean parse", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");

    const run = launch(
      baseSpec({
        harness: "opencode",
        model: "moonshotai/kimi-k3",
        prompt: "fail on purpose FAIL",
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "failed");
    const driftEvents = eventsAfter(run.id, 0).filter(
      (e: any) => e.kind === "error" && (e.payload as any)?.note === "unknown-native-event",
    );
    assert.equal(driftEvents.length, 0, "a cleanly parsed error envelope must not also produce drift events");
  });

  test("opencode: native resume via -s continues the same session", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

    const parentRun = launch(
      baseSpec({
        harness: "opencode",
        model: "moonshotai/kimi-k3",
        prompt: "first step: produce out.txt",
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    const parent = await waitTerminal(() => getRun(parentRun.id));
    assert.equal(parent.session_id, "ses_fake05772ffeXi7yksg5cygHR7");

    const resumed = launch(
      baseSpec({
        harness: "opencode",
        model: "moonshotai/kimi-k3",
        prompt: "second step: append",
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
      { parent },
    );
    const resumedDone = await waitTerminal(() => getRun(resumed.id));
    assert.equal(resumedDone.exit, "succeeded");
    assert.equal(resumedDone.session_id, parent.session_id);
    const content = readFileSync(join(parent.workdir, "out.txt"), "utf8");
    assert.ok(content.includes("resumed OK")); // the fake appends only under -s
  });

  test("opencode: --budget is enforceable mid-run in gateway mode (metered deltas)", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");

    const run = launch(
      baseSpec({
        harness: "opencode",
        model: "moonshotai/kimi-k3",
        prompt: "spend too much OVERBUDGET",
        artifacts: ["out.txt"],
        budget_usd: 1,
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "killed");
    const capEvents = eventsAfter(run.id, 0).filter(
      (e: any) => e.kind === "error" && (e.payload as any)?.note === "cap-exceeded",
    );
    assert.equal(capEvents.length, 1);
    assert.ok(String((capEvents[0]!.payload as any).detail).includes("budget"));
  });

  test("opencode: subscription without a provider-prefixed model is refused", async () => {
    const { launch } = await import("../src/core/launch.ts");
    // Locally (resident auth.json): the model-requirement error. CI: no-login. Both fail closed.
    assert.throws(
      () => launch(baseSpec({ harness: "opencode", auth: { mode: "subscription" } }) as never),
      /opencode requires --model|no resident opencode login/,
    );
  });

  test("opencode: api_key mode refused with an honest rationale", async () => {
    const { launch } = await import("../src/core/launch.ts");
    assert.throws(
      () => launch(baseSpec({ harness: "opencode", auth: { mode: "api_key" } }) as never),
      /does not support auth mode "api_key"[\s\S]*provider prefix/,
    );
  });

  test("resume: linked run in the parent's workdir continuing the native session", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

    const parentRun = launch(
      baseSpec({
        harness: "codex",
        prompt: "first step: produce out.txt",
        artifacts: ["out.txt"],
        auth: { mode: "api_key" },
      }) as never,
    );
    const parent = await waitTerminal(() => getRun(parentRun.id));
    assert.equal(parent.session_id, "fake-thread-0001");

    const resumed = launch(
      baseSpec({
        harness: "codex",
        prompt: "second step: append",
        artifacts: ["out.txt"],
        auth: { mode: "api_key" },
      }) as never,
      { parent },
    );
    assert.equal(resumed.parent_run_id, parent.id);
    assert.equal(resumed.root_run_id, parent.root_run_id);
    assert.equal(resumed.workdir, parent.workdir); // SAME worktree, not a new one

    const resumedDone = await waitTerminal(() => getRun(resumed.id));
    assert.equal(resumedDone.exit, "succeeded");
    assert.equal(resumedDone.session_id, parent.session_id); // continued, not fresh
    const content = readFileSync(join(parent.workdir, "out.txt"), "utf8");
    assert.ok(content.includes("resumed OK")); // the fake appends only under exec resume
  });

  test("resume: refused for a parent without a session_id", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, updateRun } = await import("../src/core/db.ts");
    const parentRun = launch(
      baseSpec({ harness: "codex", prompt: "x", artifacts: ["out.txt"], auth: { mode: "api_key" } }) as never,
    );
    const parent = await waitTerminal(() => getRun(parentRun.id));
    updateRun(parent.id, { session_id: null });
    assert.throws(
      () =>
        launch(baseSpec({ harness: "codex", prompt: "y", auth: { mode: "api_key" } }) as never, {
          parent: getRun(parent.id)!,
        }),
      /no session reference/,
    );
  });

  test("capability honesty: resume declarations are backed by real resume argv", async () => {
    const { ADAPTERS } = await import("../src/core/adapters/registry.ts");
    for (const adapter of ADAPTERS) {
      if (adapter.capabilities.resume !== "native") continue;
      const { argv } = adapter.buildCommand({
        spec: baseSpec({ harness: adapter.name, auth: { mode: "api_key" } }) as never,
        binPath: "/bin/echo",
        workdir: join(home, "cap-check-work"),
        credential: { envVar: "X_KEY", value: "x-not-real-x" },
        resumeSessionId: "SESSION-REF-123",
      });
      assert.ok(argv.join(" ").includes("SESSION-REF-123"), `${adapter.name} resume argv lacks the session ref`);
    }
  });

  test("TOML parser keeps '#' inside quoted values", async () => {
    const { loadConfig } = await import("../src/core/config.ts");
    const configPath = join(home, "config.toml");
    const original = readFileSync(configPath, "utf8");
    try {
      writeFileSync(configPath, `[notify]\nwebhook = "https://example.com/hook?tag=a # not a comment"\n`);
      assert.equal(loadConfig().notify.webhook, "https://example.com/hook?tag=a # not a comment");
    } finally {
      writeFileSync(configPath, original);
    }
  });

  test("detect() --version probe timeout: MC_DETECT_TIMEOUT_MS overrides the 10s default, invalid values fall back", async () => {
    const { detectTimeoutMs } = await import("../src/core/adapters/detect-timeout.ts");
    const original = process.env.MC_DETECT_TIMEOUT_MS;
    try {
      delete process.env.MC_DETECT_TIMEOUT_MS;
      assert.equal(detectTimeoutMs(), 10_000);

      process.env.MC_DETECT_TIMEOUT_MS = "30000";
      assert.equal(detectTimeoutMs(), 30_000);

      // Fail-safe: a malformed or non-positive override must not disable the
      // probe outright (e.g. 0 or NaN would make every detect() call fail
      // instantly) - fall back to the default instead.
      process.env.MC_DETECT_TIMEOUT_MS = "not-a-number";
      assert.equal(detectTimeoutMs(), 10_000);
      process.env.MC_DETECT_TIMEOUT_MS = "-5";
      assert.equal(detectTimeoutMs(), 10_000);
      process.env.MC_DETECT_TIMEOUT_MS = "0";
      assert.equal(detectTimeoutMs(), 10_000);
    } finally {
      if (original === undefined) delete process.env.MC_DETECT_TIMEOUT_MS;
      else process.env.MC_DETECT_TIMEOUT_MS = original;
    }
  });

  test("preflight refuses unknown gateway and non-prefixed model", async () => {
    const { launch } = await import("../src/core/launch.ts");

    assert.throws(
      () => launch(baseSpec({ model: "a/b", auth: { mode: "gateway", gateway: "nope" } }) as never),
      /unknown gateway/,
    );

    assert.throws(
      () => launch(baseSpec({ model: "kimi-k3", auth: { mode: "gateway", gateway: "openrouter" } }) as never),
      /provider-prefixed/,
    );
  });

  test("gateway run wires the shim env, never leaks ANTHROPIC_API_KEY, never trusts the cost figure", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

    const envDump = join(home, "gw-env.json");
    const run = launch(
      baseSpec({
        model: "moonshotai/kimi-k3",
        prompt: `gateway wiring test DUMPENV:${envDump}`,
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    const done = await waitTerminal(() => getRun(run.id));

    assert.equal(done.cost_basis, "unavailable");
    assert.equal(done.cost_usd, null); // the CLI's figure is unreliable under gateway; events keep it
    assert.equal(done.tokens_in, 1000); // tokens are the honest signal

    const childEnv = JSON.parse(readFileSync(envDump, "utf8"));
    assert.equal(childEnv.ANTHROPIC_BASE_URL, "https://openrouter.ai/api");
    assert.equal(childEnv.ANTHROPIC_AUTH_TOKEN, "or-poison-not-real");
    assert.equal(childEnv.ANTHROPIC_MODEL, "moonshotai/kimi-k3");
    assert.equal(childEnv.CLAUDE_CODE_SUBAGENT_MODEL, "moonshotai/kimi-k3");
    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  });

  test("workspace containment refuses agent-state directories", async () => {
    const { launch } = await import("../src/core/launch.ts");
    assert.throws(() => launch(baseSpec({ cwd: join(process.env.HOME!, ".claude") }) as never), /agent-state/);
  });

  test("preflight refuses --budget on claude-code even when metered (terminal-only cost)", async () => {
    const { launch } = await import("../src/core/launch.ts");
    assert.throws(() => launch(baseSpec({ budget_usd: 5 }) as never), /cannot be enforced/);
  });

  test("preflight refuses artifact paths that escape the workdir", async () => {
    const { launch } = await import("../src/core/launch.ts");
    assert.throws(() => launch(baseSpec({ artifacts: ["../spec.json"] }) as never), /escapes the run workdir/);
    assert.throws(() => launch(baseSpec({ artifacts: ["/etc/passwd"] }) as never), /escapes the run workdir/);
  });

  test("preflight refuses an artifact path that resolves to the workdir root itself (--artifact ., empty, or a no-op relative path)", async () => {
    const { launch } = await import("../src/core/launch.ts");
    // `.` and "" previously resolved to the workdir root and PASSED validation
    // (the check allowed `resolved === root`), so a declared artifact of "."
    // - or an empty string via `--spec -` - trivially satisfied the artifact
    // check against whatever the workdir already contained.
    assert.throws(() => launch(baseSpec({ artifacts: ["."] }) as never), /escapes the run workdir/);
    assert.throws(() => launch(baseSpec({ artifacts: [""] }) as never), /escapes the run workdir/);
    assert.throws(() => launch(baseSpec({ artifacts: ["   "] }) as never), /escapes the run workdir/);
    assert.throws(() => launch(baseSpec({ artifacts: ["sub/.."] }) as never), /escapes the run workdir/);
  });

  test("preflight refuses invalid cap values", async () => {
    const { launch } = await import("../src/core/launch.ts");
    assert.throws(() => launch(baseSpec({ max_minutes: -5 }) as never), /finite positive/);
    assert.throws(() => launch(baseSpec({ max_minutes: Number.NaN }) as never), /finite positive/);
  });

  test("preflight refuses a non-git --cwd instead of silently hiding inputs", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const plainDir = mkdtempSync(join(tmpdir(), "mc-nongit-"));
    try {
      assert.throws(() => launch(baseSpec({ cwd: plainDir }) as never), /not a git repository/);
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  test("codex: harness-reported failure lands failed with a clean parse", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");

    const run = launch(
      baseSpec({ harness: "codex", prompt: "fail on purpose FAIL", artifacts: ["out.txt"], auth: { mode: "api_key" } }) as never,
    );
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "failed");
    const driftEvents = eventsAfter(run.id, 0).filter(
      (e: any) => e.kind === "error" && (e.payload as any)?.note === "unknown-native-event",
    );
    assert.equal(driftEvents.length, 0, "cleanly parsed harness errors must not also produce drift events");
  });

  test("codex: mcp_tool_call and web_search items don't produce error events, and the tool name/result are captured", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");

    // Real codex exec-item types (confirmed against the installed codex-cli
    // 0.145.0 binary's item-type enum) that previously had no branch and fell
    // to the `else` -> unknown-native-event on any run that used an MCP tool
    // or web search.
    const run = launch(
      baseSpec({ harness: "codex", prompt: "produce out.txt MCPTOOLS", artifacts: ["out.txt"], auth: { mode: "api_key" } }) as never,
    );
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "succeeded");
    // Codex may also emit its own benign harness-error diagnostics (e.g. a
    // model-metadata fallback notice) on a run that legitimately succeeds -
    // those are expected and must not gate anything. What must NOT appear is
    // parser drift: mcp_tool_call/web_search previously had no branch and
    // fell to unknown-native-event.
    const driftEvents = eventsAfter(run.id, 0).filter(
      (e: any) => e.kind === "error" && (e.payload as any)?.note === "unknown-native-event",
    );
    assert.equal(driftEvents.length, 0, "mcp_tool_call/web_search items must not produce drift events");

    // The ThreadItem binding carries `server` and `tool` as separate fields -
    // the tool_call event must be keyed on `tool` (the actual tool name), not
    // fall back to `server` and lose which tool ran.
    const events = eventsAfter(run.id, 0);
    const toolCalls = events.filter((e: any) => e.kind === "tool_call").map((e: any) => e.payload as any);
    const mcpCall = toolCalls.find((p) => p.name === "fake_tool");
    assert.ok(mcpCall, `mcp_tool_call must be captured under item.tool, got names: ${toolCalls.map((p) => p.name)}`);
    const webSearchCall = toolCalls.find((p) => p.name === "web_search");
    assert.ok(webSearchCall, "web_search tool_call missing");

    // result is a structured McpToolCallResult object, not a string - the
    // excerpt must be a readable serialization, never "[object Object]". The
    // fixture also emits a command_execution tool_result ("hi\n"), so check
    // across all tool_result excerpts rather than assuming stream order.
    const excerpts = events
      .filter((e: any) => e.kind === "tool_result")
      .map((e: any) => String((e.payload as any).excerpt));
    assert.ok(!excerpts.some((x) => x.includes("[object Object]")), `excerpt collapsed to [object Object]: ${excerpts}`);
    assert.ok(excerpts.some((x) => x.includes("tool ok")), `missing mcp_tool_call result excerpt, got: ${excerpts}`);
  });

  test("mc kill: a harness that traps SIGTERM and exits 0 anyway still lands `killed`, not `succeeded`", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));

    const run = launch(
      baseSpec({ harness: "codex", prompt: "hang until killed TRAPSIGTERM", auth: { mode: "api_key" } }) as never,
    );

    // `mc kill` requires exit === "running" with a pid recorded - wait for the
    // supervisor to actually spawn the child.
    const start = Date.now();
    let running = getRun(run.id)!;
    while (running.exit !== "running" || !running.pid) {
      if (Date.now() - start > 10000) throw new Error(`run never reached running: ${JSON.stringify(running)}`);
      await sleep(100);
      running = getRun(run.id)!;
    }

    const res = spawnSync(process.execPath, [entry, "kill", run.id], { encoding: "utf8", env: { ...process.env } });
    assert.equal(res.status, 0, res.stderr);

    const done = await waitTerminal(() => getRun(run.id));
    // The fixture traps SIGTERM, finishes its turn, and exits 0 - the old
    // exitCode-only (plus signal-only) classification would call this
    // `succeeded`, since neither exitCode nor a raw kill signal fired.
    assert.equal(done.exit, "killed");
    assert.notEqual(done.exit, "succeeded");
  });

  test("CLI resume inherits artifacts/caps from the parent; flags override", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, findRun } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));

    const parentRun = launch(
      baseSpec({
        harness: "codex",
        prompt: "first: produce out.txt",
        artifacts: ["out.txt"],
        max_minutes: 30,
        auth: { mode: "api_key" },
      }) as never,
    );
    const parent = await waitTerminal(() => getRun(parentRun.id));

    // Inheritance: no flags -> parent's artifacts and cap carry over.
    const res = spawnSync(process.execPath, [entry, "resume", parent.id, "second: append"], {
      encoding: "utf8",
      env: { ...process.env },
    });
    assert.equal(res.status, 0, res.stderr);
    const childId = res.stdout.trim().split(/\s+/)[0]!;
    const child = await waitTerminal(() => findRun(childId));
    assert.deepEqual(child.artifacts, ["out.txt"]);
    assert.equal(child.max_minutes, 30);
    assert.equal(child.parent_run_id, parent.id);
    assert.equal(child.exit, "succeeded");

    // Override: explicit --artifact replaces the inherited list.
    const res2 = spawnSync(process.execPath, [entry, "resume", parent.id, "--artifact", "other.txt", "third: something else"], {
      encoding: "utf8",
      env: { ...process.env },
    });
    assert.equal(res2.status, 0, res2.stderr);
    const child2 = await waitTerminal(() => findRun(res2.stdout.trim().split(/\s+/)[0]!));
    assert.deepEqual(child2.artifacts, ["other.txt"]); // the override really applied, not just accepted and ignored
  });

  test("resume --fresh: checkpoint restart in a NEW worktree with a NEW session", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, findRun } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));

    const repo = mkdtempSync(join(tmpdir(), "mc-fresh-"));
    try {
      spawnSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
      writeFileSync(join(repo, "README.md"), "seed\n");
      spawnSync("sh", ["-c", `git -C ${repo} add -A && git -C ${repo} -c user.email=t@t -c user.name=t commit -q -m seed`], { stdio: "ignore" });

      const parentRun = launch(
        baseSpec({ prompt: "do the work and commit it GITCOMMIT", cwd: repo, artifacts: ["out.txt"] }) as never,
      );
      const parent = await waitTerminal(() => getRun(parentRun.id));
      assert.equal(parent.exit, "succeeded");
      const parentHead = spawnSync("git", ["-C", parent.workdir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

      const res = spawnSync(process.execPath, [entry, "resume", parent.id, "--fresh", "start over from the checkpoint"], {
        encoding: "utf8",
        env: { ...process.env },
      });
      assert.equal(res.status, 0, res.stderr);
      const child = await waitTerminal(() => findRun(res.stdout.trim().split(/\s+/)[0]!));
      assert.notEqual(child.workdir, parent.workdir); // NEW worktree, not the parent's
      assert.equal(child.parent_run_id, parent.id);
      assert.deepEqual(child.artifacts, ["out.txt"]); // inherited
      assert.equal(child.exit, "succeeded");

      const childSpec = JSON.parse(readFileSync(child.spec_path, "utf8"));
      assert.equal(childSpec.resume_session_id, undefined); // NEW session by design
      assert.equal(childSpec.checkpoint, parentHead); // anchored at the parent's HEAD

      // --at with a non-commit is refused at preflight.
      const bad = spawnSync(process.execPath, [entry, "resume", parent.id, "--fresh", "--at", "deadbeef", "x"], {
        encoding: "utf8",
        env: { ...process.env },
      });
      assert.equal(bad.status, 1);
      assert.ok(bad.stderr.includes("not a commit"), bad.stderr);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("mc reap: marks dead-supervisor runs lost and delivers their notification", async () => {
    const { insertRun, getRun } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));

    const id = "feed01";
    insertRun({
      id, parent_run_id: null, root_run_id: id, harness: "claude-code", model: null,
      host: "test", prompt: "orphaned run", title: "orphaned run", spec_path: join(home, "none.json"),
      workdir: join(home, "none"), session_id: null, exit: "running",
      started_at: new Date(Date.now() - 60_000).toISOString(), ended_at: null,
      cost_usd: null, cost_basis: "unavailable", tokens_in: null, tokens_out: null,
      budget_usd: null, max_minutes: null, auth_mode: "api_key", gateway: null,
      pid: null, supervisor_pid: 999_999_999, stderr_path: join(home, "none.log"),
      artifacts: [], notified: false,
    } as never);

    const res = spawnSync(process.execPath, [entry, "reap"], { encoding: "utf8", env: { ...process.env } });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes("reaped 1 lost"), res.stdout);
    const reaped = getRun(id)!;
    assert.equal(reaped.exit, "lost");
    assert.equal(reaped.notified, true);
    // A lost run has no error-kind event; its push must still explain WHY,
    // carrying the reason reap recorded on the exited event (not error: null).
    const payload = JSON.parse(readFileSync(join(home, "notified.json"), "utf8"));
    assert.equal(payload.id, id);
    assert.ok(String(payload.error).includes("watcher died"), `lost notify should carry its reason, got: ${payload.error}`);
  });

  test("mc kill: SIGTERM escalates and no orphaned harness process is left behind", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));

    // Long enough that without a working kill this test's own timeout would
    // fire first - the escalation, not the fixture exiting on its own, is
    // what has to end this run.
    const run = launch(baseSpec({ prompt: "hang silently SLEEP:60000", artifacts: ["out.txt"] }) as never);
    const running = await waitRunning(() => getRun(run.id));
    assert.ok(running.pid! > 0);
    assert.ok(pidAlive(running.pid), "harness pid should be alive before kill");

    const res = spawnSync(process.execPath, [entry, "kill", run.id], { encoding: "utf8", env: { ...process.env } });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes("kill requested"), res.stdout);

    const done = await waitTerminal(() => getRun(run.id), 15000);
    assert.equal(done.exit, "killed");
    // The whole point of process-group containment: the harness pid is
    // actually dead, not just marked killed in the ledger.
    assert.equal(pidAlive(done.pid), false, `pid ${done.pid} still alive after mc kill`);
  });

  test("mc kill: a lost-but-alive run (dead supervisor, live harness) is now killable", async () => {
    const { insertRun, insertEvent, eventsAfter } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));

    // Fabricate exactly the case the old hard `exit === "running"` guard could
    // never reach: a dead supervisor (no watcher pid alive) with a real, live,
    // detached (process-group-leader) harness still running unwatched.
    const workdir = join(home, "lost-none");
    const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    orphan.unref();
    await sleep(200); // give it a moment to actually be running

    const id = "l0st001";
    insertRun({
      id, parent_run_id: null, root_run_id: id, harness: "claude-code", model: null,
      host: "test", prompt: "orphaned harness", title: "orphaned harness", spec_path: join(home, "lost-none.json"),
      workdir, session_id: null, exit: "lost",
      started_at: new Date(Date.now() - 120_000).toISOString(), ended_at: new Date().toISOString(),
      cost_usd: null, cost_basis: "unavailable", tokens_in: null, tokens_out: null,
      budget_usd: null, max_minutes: null, auth_mode: "api_key", gateway: null,
      pid: orphan.pid, supervisor_pid: 999_999_998, stderr_path: join(home, "lost-none.log"),
      // notified: true - a lost run that's been DETECTED (which fabricating
      // exit: "lost" directly simulates) would already have had its
      // notification delivered by the reap that marked it lost; leaving this
      // false would make an unrelated `mc reap` sweep it and double-fire hooks.
      artifacts: [], notified: true,
    } as never);
    // The ownership check (start-time identity) needs a recorded `pid_start`
    // to compare against - this is what supervisor.ts writes at real spawn
    // time; fabricate the same event here since this row bypassed supervise().
    insertEvent(id, "status_change", {
      exit: "running", pid: orphan.pid, supervisor_pid: 999_999_998, pid_start: psLstart(orphan.pid!),
    });
    assert.ok(pidAlive(orphan.pid), "sanity: orphan must be alive before mc kill runs");

    // Async, not spawnSync: this test is itself the orphan's parent, and a
    // synchronous spawn would block this process from reaping it - see runMc.
    const res = await runMc(entry, ["kill", id]);
    // The old code: `if (run.exit !== "running") fail(...)` - a "lost" row was
    // unconditionally refused here, even with a live pid. This must now work.
    assert.equal(res.status, 0, res.stderr);

    // mc kill's own escalation already waited this out; poll a little more for CI slack.
    const start = Date.now();
    while (pidAlive(orphan.pid) && Date.now() - start < 15000) await sleep(200);
    assert.equal(pidAlive(orphan.pid), false, `orphaned harness pid ${orphan.pid} still alive after mc kill`);

    const killRequested = eventsAfter(id, 0).find(
      (e: any) => e.kind === "status_change" && (e.payload as any)?.kill_requested,
    );
    assert.ok(killRequested, "kill_requested event missing for the lost-but-alive run");
  });

  test("mc kill: refuses a lost run whose pid now belongs to an unrelated process (possible PID reuse)", async () => {
    const { insertRun, insertEvent, eventsAfter } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));

    // A real, live process standing in for "the recorded pid got reused by
    // something else" (or by a different concurrent run of the SAME harness
    // binary - a command-line match alone couldn't tell those apart, which
    // is exactly why the ownership check is start-time identity, not a
    // command-line substring match).
    const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    stranger.unref();
    await sleep(200);

    const id = "reuse01";
    insertRun({
      id, parent_run_id: null, root_run_id: id, harness: "claude-code", model: null,
      host: "test", prompt: "stale lost row", title: "stale lost row", spec_path: join(home, "reuse-none.json"),
      workdir: join(home, "reuse-none-workdir"), session_id: null, exit: "lost",
      started_at: new Date(Date.now() - 3_600_000).toISOString(), ended_at: new Date().toISOString(),
      cost_usd: null, cost_basis: "unavailable", tokens_in: null, tokens_out: null,
      budget_usd: null, max_minutes: null, auth_mode: "api_key", gateway: null,
      pid: stranger.pid, supervisor_pid: 999_999_994, stderr_path: join(home, "reuse-none.log"),
      artifacts: [], notified: true,
    } as never);
    // The recorded start time is from "the original harness" this pid used
    // to belong to - deliberately NOT the stand-in process's real start
    // time, simulating the pid having been reused since.
    insertEvent(id, "status_change", {
      exit: "running", pid: stranger.pid, supervisor_pid: 999_999_994,
      pid_start: "Thu Jan  1 00:00:00 1970",
    });

    try {
      assert.ok(pidAlive(stranger.pid), "sanity: the stand-in process must be alive before mc kill runs");
      assert.notEqual(psLstart(stranger.pid!), "Thu Jan  1 00:00:00 1970", "sanity: the fabricated start time must not coincide with reality");

      const res = await runMc(entry, ["kill", id]);
      assert.equal(res.status, 1);
      assert.ok(res.stderr.includes("start time mismatch"), res.stderr);
      assert.ok(res.stderr.includes("PID reuse"), res.stderr);
      assert.ok(res.stderr.includes(String(stranger.pid)), res.stderr);

      // Refused, not signalled: the unrelated process must be untouched, and
      // no kill_requested event should have been recorded for it either.
      assert.ok(pidAlive(stranger.pid), "the unrelated process must not have been touched by mc kill");
      const killRequested = eventsAfter(id, 0).find(
        (e: any) => e.kind === "status_change" && (e.payload as any)?.kill_requested,
      );
      assert.ok(!killRequested, "kill_requested must not be recorded for a refused PID-reuse kill");
    } finally {
      if (stranger.pid) process.kill(stranger.pid, "SIGKILL");
    }
  });

  test("mc kill: bare-pid fallback still escalates to SIGKILL when the group signal is unavailable", async () => {
    const { insertRun, insertEvent } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));

    // NOT spawned detached: its process-group id is inherited from this test
    // process (not itself), so `process.kill(-pid, ...)` treating its own
    // pid as a group id fails with ESRCH and killGroupOrPid must fall back
    // to a bare-pid signal. It also traps and ignores SIGTERM, so only a
    // SIGKILL can end it - exactly the regression: escalation polling
    // groupAlive() unconditionally reads "dead" on the very first ESRCH
    // check and skips SIGKILL entirely, leaving this alive forever.
    const stubborn = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { stdio: "ignore" },
    );
    stubborn.unref();
    await sleep(300);
    assert.ok(pidAlive(stubborn.pid), "sanity: stubborn process must be alive before mc kill runs");

    const id = "bare0001";
    insertRun({
      id, parent_run_id: null, root_run_id: id, harness: "claude-code", model: null,
      host: "test", prompt: "non-grouped, SIGTERM-ignoring harness", title: "non-grouped harness",
      spec_path: join(home, "bare-none.json"), workdir: join(home, "bare-none"), session_id: null,
      exit: "lost",
      started_at: new Date(Date.now() - 120_000).toISOString(), ended_at: new Date().toISOString(),
      cost_usd: null, cost_basis: "unavailable", tokens_in: null, tokens_out: null,
      budget_usd: null, max_minutes: null, auth_mode: "api_key", gateway: null,
      pid: stubborn.pid, supervisor_pid: 999_999_993, stderr_path: join(home, "bare-none.log"),
      artifacts: [], notified: true,
    } as never);
    insertEvent(id, "status_change", {
      exit: "running", pid: stubborn.pid, supervisor_pid: 999_999_993, pid_start: psLstart(stubborn.pid!),
    });

    try {
      const res = await runMc(entry, ["kill", id]);
      assert.equal(res.status, 0, res.stderr);

      // SIGTERM alone never kills it (trapped and ignored) - only a
      // correctly-escalated bare-pid SIGKILL does.
      const start = Date.now();
      while (pidAlive(stubborn.pid) && Date.now() - start < 15000) await sleep(200);
      assert.equal(pidAlive(stubborn.pid), false, `pid ${stubborn.pid} still alive after mc kill (bare-pid SIGKILL never fired)`);
    } finally {
      if (stubborn.pid && pidAlive(stubborn.pid)) process.kill(stubborn.pid, "SIGKILL");
    }
  });

  test("mc kill: still refuses a lost run whose pid is already dead", async () => {
    const { insertRun } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));

    const id = "dead0001";
    insertRun({
      id, parent_run_id: null, root_run_id: id, harness: "claude-code", model: null,
      host: "test", prompt: "long dead", title: "long dead", spec_path: join(home, "dead-none.json"),
      workdir: join(home, "dead-none"), session_id: null, exit: "lost",
      started_at: new Date(Date.now() - 120_000).toISOString(), ended_at: new Date().toISOString(),
      cost_usd: null, cost_basis: "unavailable", tokens_in: null, tokens_out: null,
      budget_usd: null, max_minutes: null, auth_mode: "api_key", gateway: null,
      pid: 999_999_997, supervisor_pid: 999_999_996, stderr_path: join(home, "dead-none.log"),
      artifacts: [], notified: true,
    } as never);
    assert.ok(!pidAlive(999_999_997), "sanity: this pid must not actually exist");

    const res = spawnSync(process.execPath, [entry, "kill", id], { encoding: "utf8", env: { ...process.env } });
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes("not killable"), res.stderr);
  });

  test("notify_result records that no hooks were configured", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");
    const configPath = join(home, "config.toml");
    const original = readFileSync(configPath, "utf8");
    try {
      writeFileSync(configPath, "# no notify hooks\n");
      const run = launch(baseSpec({ prompt: "quiet run", artifacts: ["out.txt"] }) as never);
      const done = await waitTerminal(() => getRun(run.id));
      assert.equal(done.notified, true); // obligation discharged...
      const notify = eventsAfter(run.id, 0).find((e: any) => e.kind === "notify_result");
      assert.ok(notify, "notify_result event missing");
      assert.deepEqual((notify!.payload as any).configured, []); // ...but the ledger says nobody was told
      assert.ok(String((notify!.payload as any).note).includes("no notify hooks"));
    } finally {
      writeFileSync(configPath, original);
    }
  });

  function placeholderRun(id: string, overrides: Record<string, unknown>) {
    return {
      id, parent_run_id: null, root_run_id: id, harness: "claude-code", model: null,
      host: "test", prompt: "placeholder", title: "placeholder", spec_path: join(home, `${id}.json`),
      workdir: join(home, id), session_id: null, exit: "succeeded",
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      cost_usd: null, cost_basis: "unavailable", tokens_in: null, tokens_out: null,
      budget_usd: null, max_minutes: null, auth_mode: "api_key" as const, gateway: null,
      pid: null, supervisor_pid: null, stderr_path: join(home, `${id}.log`),
      artifacts: [], notified: false,
      ...overrides,
    };
  }

  test("mc ls shows TOKENS/DURATION columns; mc show prints a cost/tokens/duration summary", async () => {
    const { insertRun } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));

    const id = "tok00001";
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const endedAt = new Date().toISOString();
    insertRun(
      placeholderRun(id, {
        started_at: startedAt,
        ended_at: endedAt,
        cost_usd: 0.79,
        cost_basis: "metered",
        tokens_in: 73_000,
        tokens_out: 5_700,
        // Terminal (succeeded, from placeholderRun's default) and unnotified
        // would otherwise sit in the DB as a leftover `mc reap` picks up in a
        // later test (see the epipe test's own comment on this exact trap) -
        // this test doesn't exercise notify, so mark it already-delivered.
        notified: true,
      }) as never,
    );

    const ls = spawnSync(process.execPath, [entry, "ls"], { encoding: "utf8", env: { ...process.env } });
    assert.equal(ls.status, 0, ls.stderr);
    assert.ok(ls.stdout.includes("TOKENS"), ls.stdout);
    assert.ok(ls.stdout.includes("DURATION"), ls.stdout);
    assert.ok(ls.stdout.includes("73k/6k"), ls.stdout); // 5700 rounds to 6k
    assert.ok(ls.stdout.includes("5m"), ls.stdout);

    const show = spawnSync(process.execPath, [entry, "show", id], { encoding: "utf8", env: { ...process.env } });
    assert.equal(show.status, 0, show.stderr);
    assert.ok(show.stdout.includes("cost=$0.79  tokens=73k/6k  duration=5m"), show.stdout);

    // A run genuinely still running (no ended_at yet) degrades tokens/duration
    // to "-", never a crash or a misleading number for a run that hasn't
    // reported anything yet. pid=own test process so reapLostRuns (which `ls`
    // calls) sees a live watcher and leaves it running instead of reaping it.
    const bareId = "tok00002";
    insertRun(
      placeholderRun(bareId, {
        ended_at: null,
        exit: "running",
        pid: process.pid,
        supervisor_pid: process.pid,
        notified: true,
      }) as never,
    );
    const lsBare = spawnSync(process.execPath, [entry, "ls"], { encoding: "utf8", env: { ...process.env } });
    assert.equal(lsBare.status, 0, lsBare.stderr);
    const bareLine = lsBare.stdout.split("\n").find((l) => l.includes(bareId));
    assert.ok(bareLine, lsBare.stdout);
    assert.match(bareLine!, /running\s+-\s+-\s+-\s+\d+s\s*$/); // COST/TOKENS/DURATION all "-", AGE last
  });

  test("mc ls --exit filters by state, composes with --json, rejects bad input", async () => {
    const { insertRun } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));

    // Runs on distinct exit states. Other tests' rows share this DB, so
    // assertions are include/exclude on these ids, never exact counts.
    // notified: true on terminal rows so no later reap picks them up; live
    // pid on the running row so ls's reap pass leaves it running.
    insertRun(placeholderRun("flt00001", { notified: true }) as never); // succeeded (default)
    insertRun(
      placeholderRun("flt00002", {
        ended_at: null, exit: "running",
        pid: process.pid, supervisor_pid: process.pid, notified: true,
      }) as never,
    );
    insertRun(placeholderRun("flt00003", { exit: "failed", notified: true }) as never);

    const mcLs = (...extra: string[]) =>
      spawnSync(process.execPath, [entry, "ls", ...extra], { encoding: "utf8", env: { ...process.env } });

    const running = mcLs("--exit", "running");
    assert.equal(running.status, 0, running.stderr);
    assert.ok(running.stdout.includes("flt00002"), running.stdout);
    assert.ok(!running.stdout.includes("flt00001"), running.stdout);
    assert.ok(!running.stdout.includes("flt00003"), running.stdout);

    // Comma-separated values, composed with --json: the filtered result is
    // still the clean JSON interface, and every returned row satisfies the
    // filter (not just the fixtures this test planted).
    const badJson = mcLs("--exit", "failed,killed,lost", "--json");
    assert.equal(badJson.status, 0, badJson.stderr);
    const badRows = JSON.parse(badJson.stdout) as { id: string; exit: string }[];
    assert.ok(badRows.some((r) => r.id === "flt00003"), badJson.stdout);
    assert.ok(badRows.every((r) => ["failed", "killed", "lost"].includes(r.exit)), badJson.stdout);
    assert.ok(!badRows.some((r) => r.id === "flt00001" || r.id === "flt00002"), badJson.stdout);

    // A typo'd VALUE must fail loudly with the valid set, never silently
    // match nothing.
    const typo = mcLs("--exit", "runing");
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /unknown --exit value "runing"/);
    assert.match(typo.stderr, /running/); // error lists the valid values

    const missing = mcLs("--exit");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--exit requires a value/);

    // A misspelled FLAG must also fail loudly - skipping it would return the
    // full unfiltered ledger with exit 0 to a consumer that believes it
    // filtered (worse than any error).
    const typoFlag = mcLs("--exiit", "running", "--json");
    assert.equal(typoFlag.status, 1);
    assert.match(typoFlag.stderr, /unknown ls argument "--exiit"/);

    const stray = mcLs("running");
    assert.equal(stray.status, 1);
    assert.match(stray.stderr, /unknown ls argument "running"/);

    // All-empty tokens (`--exit ','`, or automation interpolating an empty
    // variable) must not degrade to "no filter" and return the full ledger.
    const emptyTokens = mcLs("--exit", ",", "--json");
    assert.equal(emptyTokens.status, 1);
    assert.match(emptyTokens.stderr, /--exit requires a value/);
  });

  test("notify hook that never reads stdin does not crash mc reap; read commands stay side-effect free", async () => {
    const { insertRun, getRun, eventsAfter, updateRun } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));
    const configPath = join(home, "config.toml");
    const original = readFileSync(configPath, "utf8");
    const counterPath = join(home, "epipe-counter.txt");

    const id = "epipe1";
    // Large enough to exceed the OS pipe buffer (observed ~64KB on both
    // Linux and macOS): the write can't complete in one synchronous syscall,
    // so part of it queues and lands after the hook has already exited and
    // closed its end - the exact EPIPE window the fix guards. A realistic
    // payload (a short title, a 300-char error excerpt) rarely reaches that
    // size, but nothing stops a long title from doing so.
    insertRun(placeholderRun(id, { title: "x".repeat(300_000), notified: false }) as never);

    try {
      // A hook that never reads stdin, exits 0, and counts its invocations.
      writeFileSync(configPath, `[notify]\nexec = "printf x >> ${counterPath}; exit 0"\n`);

      // `mc reap` is the delivering path now (`ls`/`show`/`tail` no longer
      // dispatch at all - see reapLostRuns's doc comment), so it's the one
      // that must survive the EPIPE, not crash with a raw stack trace, and
      // correctly record the truncated write as NOT delivered (round 2's
      // fix), leaving `notified` false for a later retry.
      const reap = spawnSync(process.execPath, [entry, "reap"], { encoding: "utf8", env: { ...process.env } });
      assert.equal(reap.status, 0, reap.stderr);
      assert.equal(readFileSync(counterPath, "utf8"), "x");
      assert.equal(getRun(id)!.notified, false);

      // Read commands touching the same run must not crash either, AND must
      // not re-dispatch the hook at all (side-effect free): no new
      // invocation, no new notify_result event.
      const ls = spawnSync(process.execPath, [entry, "ls"], { encoding: "utf8", env: { ...process.env } });
      assert.equal(ls.status, 0, ls.stderr);
      assert.ok(ls.stdout.includes(id), ls.stdout);

      const show = spawnSync(process.execPath, [entry, "show", id], {
        encoding: "utf8",
        env: { ...process.env },
        maxBuffer: 5 * 1024 * 1024,
      });
      assert.equal(show.status, 0, show.stderr);
      assert.ok(show.stdout.includes(id), show.stdout);

      assert.equal(readFileSync(counterPath, "utf8"), "x"); // ls/show did NOT re-invoke the hook
      assert.equal(
        eventsAfter(id, 0).filter((e: any) => e.kind === "notify_result").length,
        1, // only mc reap's attempt - ls/show recorded nothing
      );
      assert.equal(getRun(id)!.notified, false); // still pending; read commands never touch it
    } finally {
      writeFileSync(configPath, original);
      // Cleanup, not part of the assertion: this run is left permanently
      // undeliverable by design (the fixture hook never drains stdin), and
      // `mc reap` in later tests iterates every unnotified terminal run - an
      // unnotified leftover here would make an unrelated test's exec hook
      // fire an extra, unexpected time.
      updateRun(id, { notified: true });
    }
  });

  test("mc tail on a run with a permanently-failing hook terminates promptly and does not loop", async () => {
    const { insertRun, getRun, updateRun } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));
    const configPath = join(home, "config.toml");
    const original = readFileSync(configPath, "utf8");
    const counterPath = join(home, "tail-counter.txt");

    const id = "tail001";
    // Already terminal at insert time - `mc tail` should hit its
    // break condition on the very first poll if it isn't looping.
    insertRun(placeholderRun(id, { exit: "failed", notified: false }) as never);

    try {
      // Drains stdin cleanly (no EPIPE noise here) and always fails delivery.
      writeFileSync(configPath, `[notify]\nexec = "cat >/dev/null; printf x >> ${counterPath}; exit 1"\n`);

      // Before the fix, `mc tail` re-dispatched the failing hook on every
      // 500ms poll (a fresh notify_result event always counted as "new",
      // so the loop's break condition never fired) and never returned. The
      // spawnSync timeout is the backstop that turns a regression here into
      // a fast test failure instead of a hung suite.
      const tail = spawnSync(process.execPath, [entry, "tail", id], {
        encoding: "utf8",
        env: { ...process.env },
        timeout: 8_000,
      });
      assert.equal(tail.status, 0, tail.stderr || `timed out/killed: signal=${tail.signal}`);
      assert.ok(tail.stdout.includes("-- terminal:"), tail.stdout);

      // Read path: at most one invocation (in practice zero - `mc tail`
      // never dispatches at all now), and `notified` stays false, pending
      // retry via `mc reap`.
      const invocationsFromTail = existsSync(counterPath) ? readFileSync(counterPath, "utf8").length : 0;
      assert.ok(invocationsFromTail <= 1, `expected at most one hook invocation from the read path, got ${invocationsFromTail}`);
      assert.equal(getRun(id)!.notified, false);

      // The delivery path still retries.
      const reap = spawnSync(process.execPath, [entry, "reap"], { encoding: "utf8", env: { ...process.env } });
      assert.equal(reap.status, 0, reap.stderr);
      const invocationsAfterReap = readFileSync(counterPath, "utf8").length;
      assert.ok(invocationsAfterReap > invocationsFromTail, "mc reap did not retry delivery");
      assert.equal(getRun(id)!.notified, false); // still failing every time
    } finally {
      writeFileSync(configPath, original);
      updateRun(id, { notified: true });
    }
  });

  test("notify hook that reads only part of stdin then exits 0 is not recorded as delivered", async () => {
    const { insertRun, getRun, eventsAfter, updateRun } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));
    const configPath = join(home, "config.toml");
    const original = readFileSync(configPath, "utf8");
    const counterPath = join(home, "truncated-counter.txt");

    const id = "trunc01";
    // Same oversized-title mechanism as the EPIPE non-crash test above: the
    // write can't complete in one syscall, so a hook that stops reading
    // early truncates a payload that is still in flight rather than one that
    // already landed whole in the kernel pipe buffer.
    insertRun(placeholderRun(id, { title: "x".repeat(300_000), notified: false }) as never);

    try {
      // Reads only the first 10 bytes of the payload, discards the rest,
      // then exits 0. A naive "delivered = exit code === 0" read would call
      // this delivered; the payload never fully arrived at the hook.
      writeFileSync(configPath, `[notify]\nexec = "head -c 10 >/dev/null; printf x >> ${counterPath}; exit 0"\n`);

      const first = spawnSync(process.execPath, [entry, "reap"], { encoding: "utf8", env: { ...process.env } });
      assert.equal(first.status, 0, first.stderr); // truncated read must not crash either
      assert.equal(readFileSync(counterPath, "utf8"), "x");

      assert.equal(getRun(id)!.notified, false); // truncated stdin: NOT delivered, despite exit 0

      const notify = eventsAfter(id, 0)
        .filter((e: any) => e.kind === "notify_result")
        .at(-1);
      assert.ok(notify, "notify_result event missing");
      assert.equal((notify!.payload as any).channels.exec.delivered, false);

      // SPEC's no-poll contract: a later `mc reap` must retry, not skip.
      const second = spawnSync(process.execPath, [entry, "reap"], { encoding: "utf8", env: { ...process.env } });
      assert.equal(second.status, 0, second.stderr);
      assert.equal(readFileSync(counterPath, "utf8"), "xx"); // hook invoked again
      assert.equal(getRun(id)!.notified, false);
    } finally {
      writeFileSync(configPath, original);
      // Cleanup, not part of the assertion: see the comment in the EPIPE
      // test above - this run is left permanently undeliverable by design.
      updateRun(id, { notified: true });
    }
  });

  test("failing exec hook leaves notified false; a later mc reap retries delivery", async () => {
    const { insertRun, getRun, updateRun } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));
    const configPath = join(home, "config.toml");
    const original = readFileSync(configPath, "utf8");
    const counterPath = join(home, "retry-counter.txt");

    const id = "retry01";
    insertRun(placeholderRun(id, { exit: "failed", notified: false }) as never);

    try {
      // Drains stdin (no EPIPE noise here - that's the other test's concern),
      // records one invocation, then always fails to deliver.
      writeFileSync(configPath, `[notify]\nexec = "cat >/dev/null; printf x >> ${counterPath}; exit 1"\n`);

      const first = spawnSync(process.execPath, [entry, "reap"], { encoding: "utf8", env: { ...process.env } });
      assert.equal(first.status, 0, first.stderr);
      assert.equal(readFileSync(counterPath, "utf8"), "x");
      // SPEC's no-poll contract: a total delivery failure must not be
      // recorded as discharged, or an orchestrator that honors "do not poll"
      // waits forever.
      assert.equal(getRun(id)!.notified, false);

      const second = spawnSync(process.execPath, [entry, "reap"], { encoding: "utf8", env: { ...process.env } });
      assert.equal(second.status, 0, second.stderr);
      assert.equal(readFileSync(counterPath, "utf8"), "xx"); // retried: hook invoked again
      assert.equal(getRun(id)!.notified, false);
    } finally {
      writeFileSync(configPath, original);
      // Cleanup, not part of the assertion: see the comment in the EPIPE
      // test above - this run is left permanently undeliverable by design.
      updateRun(id, { notified: true });
    }
  });

  test("two concurrent notify attempts on the same run dispatch the hook at most once", async () => {
    const { insertRun, getRun } = await import("../src/core/db.ts");
    const { notifyTerminal } = await import("../src/core/notify.ts");
    const { loadConfig } = await import("../src/core/config.ts");
    const configPath = join(home, "config.toml");
    const original = readFileSync(configPath, "utf8");
    const counterPath = join(home, "conc-counter.txt");

    const id = "conc001";
    insertRun(placeholderRun(id, { notified: false }) as never);

    try {
      writeFileSync(configPath, `[notify]\nexec = "cat >/dev/null; printf x >> ${counterPath}"\n`);
      const config = loadConfig();
      // Both callers race off the SAME stale in-memory snapshot (notified:
      // false) - exactly the supervisor-vs-reap-vs-read-command race the
      // atomic claim exists to close.
      const staleRun = getRun(id)!;

      await Promise.all([notifyTerminal(staleRun, config), notifyTerminal(staleRun, config)]);

      assert.equal(readFileSync(counterPath, "utf8"), "x"); // fired at most once
      assert.equal(getRun(id)!.notified, true);
    } finally {
      writeFileSync(configPath, original);
    }
  });

  test("mc prune: classifies dirty/unintegrated/safe correctly, reclaims only safe, leaves the ledger and spec intact", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, insertRun } = await import("../src/core/db.ts");
    const { evaluateWorktree, pruneWorktree } = await import("../src/core/prune.ts");

    const repo = mkdtempSync(join(tmpdir(), "mc-prune-"));
    try {
      spawnSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
      writeFileSync(join(repo, "README.md"), "seed\n");
      spawnSync(
        "sh",
        ["-c", `git -C ${repo} add -A && git -C ${repo} -c user.email=t@t -c user.name=t commit -q -m seed`],
        { stdio: "ignore" },
      );

      // Dirty: default fake-harness path writes out.txt WITHOUT committing.
      const dirtyRun = launch(baseSpec({ prompt: "just write stuff", cwd: repo }) as never);
      const dirtyDone = await waitTerminal(() => getRun(dirtyRun.id));
      const dirtyCandidate = evaluateWorktree(dirtyDone);
      assert.equal(dirtyCandidate.status, "dirty", dirtyCandidate.detail);

      // Clean commit, but the SOURCE repo hasn't absorbed it yet - unintegrated.
      const safeRun = launch(baseSpec({ prompt: "commit it GITCOMMIT", cwd: repo }) as never);
      const safeDone = await waitTerminal(() => getRun(safeRun.id));
      const preMergeCandidate = evaluateWorktree(safeDone);
      assert.equal(preMergeCandidate.status, "unintegrated", preMergeCandidate.detail);

      // Fast-forward the source repo to that same commit - now genuinely
      // recoverable from the source repo's own history, nothing lost by
      // reclaiming the checkout.
      const head = spawnSync("git", ["-C", safeDone.workdir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      const ff = spawnSync("git", ["-C", repo, "merge", "--ff-only", head], { encoding: "utf8" });
      assert.equal(ff.status, 0, ff.stderr);
      const safeCandidate = evaluateWorktree(safeDone);
      assert.equal(safeCandidate.status, "safe", safeCandidate.detail);

      // A still-active run must never be touched, even if the filesystem
      // would otherwise look safe - status gates BEFORE any git call runs.
      const activeId = "prune-active";
      insertRun(placeholderRun(activeId, { exit: "running", workdir: join(home, "nonexistent-workdir") }) as never);
      const activeCandidate = evaluateWorktree(getRun(activeId)!);
      assert.equal(activeCandidate.status, "active");
      assert.equal(activeCandidate.sizeBytes, null);

      // Refuse to remove anything but "safe" - dirty and unintegrated stay.
      const dirtyResult = pruneWorktree(dirtyCandidate);
      assert.equal(dirtyResult.removed, false);
      assert.ok(existsSync(dirtyDone.workdir), "dirty worktree must survive a prune attempt");
      const unintegratedResult = pruneWorktree(preMergeCandidate);
      assert.equal(unintegratedResult.removed, false);

      // The actual reclaim: checkout gone, ledger/spec untouched.
      const removeResult = pruneWorktree(safeCandidate);
      assert.equal(removeResult.removed, true, removeResult.error);
      assert.ok(!existsSync(safeDone.workdir), "safe worktree must be gone after prune");
      assert.ok(existsSync(safeDone.spec_path), "spec.json must survive - only the checkout is reclaimed");
      assert.equal(getRun(safeDone.id)!.exit, "succeeded", "the ledger row itself is untouched");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("mc prune CLI: dry-run reports without deleting, --yes reclaims only safe, --json is parseable, unknown args fail loudly", async () => {
    const { insertRun, getRun } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));

    const repo = mkdtempSync(join(tmpdir(), "mc-prune-cli-"));
    try {
      spawnSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
      writeFileSync(join(repo, "README.md"), "seed\n");
      spawnSync(
        "sh",
        ["-c", `git -C ${repo} add -A && git -C ${repo} -c user.email=t@t -c user.name=t commit -q -m seed`],
        { stdio: "ignore" },
      );
      const seedHead = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

      const workdir = join(home, "prune-cli-work");
      spawnSync("git", ["-C", repo, "worktree", "add", "--detach", workdir], { stdio: "ignore" });
      // Clean, and already the repo's own HEAD - trivially integrated: safe.
      const id = "prunecli1";
      const specPath = join(home, `${id}.json`); // placeholderRun's default spec_path
      writeFileSync(specPath, "{}"); // a real file to prove prune leaves it alone
      insertRun(placeholderRun(id, { exit: "succeeded", workdir, notified: true }) as never);

      const dry = spawnSync(process.execPath, [entry, "prune"], { encoding: "utf8", env: { ...process.env } });
      assert.equal(dry.status, 0, dry.stderr);
      assert.ok(dry.stdout.includes(id), dry.stdout);
      assert.ok(dry.stdout.includes("safe to prune"), dry.stdout);
      assert.ok(existsSync(workdir), "dry-run must not delete anything");

      const json = spawnSync(process.execPath, [entry, "prune", "--json"], { encoding: "utf8", env: { ...process.env } });
      assert.equal(json.status, 0, json.stderr);
      const rows = JSON.parse(json.stdout) as { id: string; status: string; removed: boolean | null }[];
      const row = rows.find((r) => r.id === id);
      assert.ok(row, json.stdout);
      assert.equal(row!.status, "safe");
      assert.equal(row!.removed, null); // --json alone (no --yes) never removes
      assert.ok(existsSync(workdir), "--json without --yes must not delete anything");

      const apply = spawnSync(process.execPath, [entry, "prune", "--yes"], { encoding: "utf8", env: { ...process.env } });
      assert.equal(apply.status, 0, apply.stderr);
      assert.ok(apply.stdout.includes("reclaimed 1/1"), apply.stdout);
      assert.ok(!existsSync(workdir), "--yes must actually remove the safe worktree");
      assert.ok(existsSync(getRun(id)!.spec_path), "spec.json survives pruning");

      const badFlag = spawnSync(process.execPath, [entry, "prune", "--force"], { encoding: "utf8", env: { ...process.env } });
      assert.equal(badFlag.status, 1);
      assert.match(badFlag.stderr, /unknown prune argument "--force"/);

      void seedHead; // documents the fixture's starting point; not asserted on directly
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

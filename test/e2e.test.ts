import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

function baseSpec(overrides: Record<string, unknown>) {
  return {
    harness: "claude-code",
    model: null,
    prompt: "test prompt",
    cwd: null,
    artifacts: [] as string[],
    visual: false,
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

  test("run -> verified -> notified, with cost and clean child env", async () => {
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
    assert.equal(done.verdict, "verified");
    assert.ok(done.supervisor_pid > 0);
    assert.equal(done.cost_usd, 0.42);
    assert.equal(done.tokens_in, 1000);
    assert.equal(done.tokens_out, 250);
    assert.equal(done.session_id, "fake-session-123");
    assert.ok(existsSync(join(done.workdir, "out.txt")));

    // Event stream has the normalized shape.
    const events = eventsAfter(run.id, 0);
    const kinds = events.map((e: any) => e.kind);
    for (const expected of ["started", "text", "tool_call", "subagent", "cost_update", "verify_result", "notify_result", "exited"]) {
      assert.ok(kinds.includes(expected), `missing event kind ${expected} in ${kinds}`);
    }
    // A clean run synthesizes nothing: no error events of any kind.
    assert.ok(!kinds.includes("error"), `unexpected error events in ${kinds}`);

    // Subagent lifecycle (system subtypes) maps to STRUCTURED events, never to
    // errors: the run stayed `verified` above (parser health un-poisoned), and
    // the payloads carry the ids/descriptions an orchestrator renders from.
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

    // Notification fired with both axes and no credential plumbing.
    const payload = JSON.parse(readFileSync(join(home, "notified.json"), "utf8"));
    assert.equal(payload.id, run.id);
    assert.equal(payload.exit, "succeeded");
    assert.equal(payload.verdict, "verified");
    assert.equal(payload.auth_mode, "api_key");
    assert.equal(payload.gateway, undefined);

    // Env poisoning: the child got the one forwarded key and none of the residents.
    const childEnv = JSON.parse(readFileSync(envDump, "utf8"));
    assert.equal(childEnv.ANTHROPIC_API_KEY, "sk-test-not-real");
    assert.equal(childEnv.OPENROUTER_API_KEY, undefined);
    assert.equal(childEnv.HF_TOKEN, undefined);
    assert.equal(childEnv.DISABLE_AUTOUPDATER, "1");
  });

  test("failing run -> failed + failed_verification, secrets scrubbed from logs", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun, eventsAfter } = await import("../src/core/db.ts");

    const run = launch(baseSpec({ prompt: "fail on purpose FAIL LEAK", artifacts: ["out.txt"] }) as never);
    const done = await waitTerminal(() => getRun(run.id));

    assert.equal(done.exit, "failed");
    assert.equal(done.verdict, "failed_verification");

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

  test("visual run terminates at needs_human_look", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

    const run = launch(baseSpec({ prompt: "make something pretty", artifacts: ["out.txt"], visual: true }) as never);
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "succeeded");
    assert.equal(done.verdict, "needs_human_look");
  });

  test("run with no declared checks lands at unverifiable", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

    const run = launch(baseSpec({ prompt: "no artifacts declared" }) as never);
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "succeeded");
    assert.equal(done.verdict, "unverifiable");
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
      "--harness", "--model", "--cwd", "--artifact", "--visual", "--no-visual",
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

  test("codex: verified run, tokens without cost, scratch CODEX_HOME, clean env", async () => {
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
    assert.equal(done.verdict, "verified");
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

  test("pi: verified run with ACCUMULATED per-turn cost and tokens (gateway mode)", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

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
    assert.equal(done.verdict, "verified");
    // The fixture emits tool_execution_update (real pi progress noise) - if the
    // adapter mishandled it, parser_health would fail and cap this at unverifiable.
    const health = JSON.parse(done.verify_evidence).find((c: any) => c.name === "parser_health");
    assert.ok(health.passed, "pi streaming progress events must not poison parser health");
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

  test("pi: harness-reported failure lands failed_verification with a HEALTHY parser", async () => {
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
    assert.equal(done.verdict, "failed_verification");
    const health = JSON.parse(done.verify_evidence).find((c: any) => c.name === "parser_health");
    assert.ok(health.passed, "a cleanly parsed pi failure must not poison parser health");
    const err = eventsAfter(run.id, 0).find((e: any) => e.kind === "error" && (e.payload as any)?.note === "harness-error");
    assert.ok(err, "missing harness-error event for a failed pi run");
  });

  test("pi: api_key mode refused with an honest rationale", async () => {
    const { launch } = await import("../src/core/launch.ts");
    assert.throws(
      () => launch(baseSpec({ harness: "pi", auth: { mode: "api_key" } }) as never),
      /does not support auth mode "api_key"[\s\S]*auth\.json/,
    );
  });

  test("kimi-code: verified run via gateway; session captured from the trailing resume_hint", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

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
    assert.equal(done.verdict, "verified");
    // The stream has NO token/cost telemetry - null, never zero or invented.
    assert.equal(done.cost_usd, null);
    assert.equal(done.tokens_in, null);
    assert.equal(done.tokens_out, null);
    // session_id arrives only in the trailing resume_hint meta line, and the
    // retry meta noise the fixture leads with must not poison parser health.
    assert.equal(done.session_id, "session_fake0000-f0a6-4d76-811d-35e6a1e7559e");
    const health = JSON.parse(done.verify_evidence).find((c: any) => c.name === "parser_health");
    assert.ok(health.passed, "kimi meta noise must not poison parser health");

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

  test("kimi-code: failed run (empty stdout, exit 1) lands failed + failed_verification", async () => {
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
    assert.equal(done.verdict, "failed_verification");

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

  test("opencode: verified gateway run; metered per-step cost and tokens ACCUMULATE", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

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
    assert.equal(done.verdict, "verified");
    assert.equal(done.session_id, "ses_fake05772ffeXi7yksg5cygHR7");
    // Two steps: 6477+621 in, 76+27 out, 0.0216654+0.0055986 dollars - deltas SUM.
    assert.equal(done.tokens_in, 7098);
    assert.equal(done.tokens_out, 103);
    assert.ok(Math.abs(done.cost_usd - 0.027264) < 1e-6, `cost_usd ${done.cost_usd} != ~0.027264`);
    const health = JSON.parse(done.verify_evidence).find((c: any) => c.name === "parser_health");
    assert.ok(health.passed, "step_start noise must not poison parser health");

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

  test("opencode: mid-stream FAIL lands failed_verification with a HEALTHY parser", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

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
    assert.equal(done.verdict, "failed_verification");
    const health = JSON.parse(done.verify_evidence).find((c: any) => c.name === "parser_health");
    assert.ok(health.passed, "a cleanly parsed error envelope must not poison parser health");
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

  test("unreadable native stream caps the verdict at unverifiable (parser health)", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

    const run = launch(baseSpec({ prompt: "drift simulation RAWLINES", artifacts: ["out.txt"] }) as never);
    const done = await waitTerminal(() => getRun(run.id));
    // Artifact exists and exit is 0, but mc was blind - never verified.
    assert.equal(done.exit, "succeeded");
    assert.equal(done.verdict, "unverifiable");
    assert.ok(done.verify_evidence.includes("parser_health"));
  });

  test("git_effect: committed clean-tree work reaches verified", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

    const repo = mkdtempSync(join(tmpdir(), "mc-gitcommit-"));
    try {
      spawnSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
      writeFileSync(join(repo, "README.md"), "seed\n");
      spawnSync("sh", ["-c", `git -C ${repo} add -A && git -C ${repo} -c user.email=t@t -c user.name=t commit -q -m seed`], { stdio: "ignore" });

      const run = launch(baseSpec({ prompt: "do the work and commit it GITCOMMIT", cwd: repo }) as never);
      const done = await waitTerminal(() => getRun(run.id));
      // Tree is CLEAN (the agent committed) - old dirty-tree check failed this.
      assert.equal(done.exit, "succeeded");
      assert.equal(done.verdict, "verified");
      const gitCheck = JSON.parse(done.verify_evidence).find((c: any) => c.name === "git_effect");
      assert.ok(gitCheck.passed, `git_effect failed: ${gitCheck.detail}`);
      assert.ok(gitCheck.detail.includes("1 commit(s)"), gitCheck.detail);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("codex: harness-reported failure lands failed_verification with a HEALTHY parser", async () => {
    const { launch } = await import("../src/core/launch.ts");
    const { getRun } = await import("../src/core/db.ts");

    const run = launch(
      baseSpec({ harness: "codex", prompt: "fail on purpose FAIL", artifacts: ["out.txt"], auth: { mode: "api_key" } }) as never,
    );
    const done = await waitTerminal(() => getRun(run.id));
    assert.equal(done.exit, "failed");
    assert.equal(done.verdict, "failed_verification"); // an honest failure, not blindness
    const health = JSON.parse(done.verify_evidence).find((c: any) => c.name === "parser_health");
    assert.ok(health.passed, "cleanly parsed harness errors must not poison parser health");
  });

  test("CLI resume inherits artifacts/visual/caps from the parent; flags override", async () => {
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
    assert.deepEqual(child2.artifacts, ["other.txt"]);
    assert.equal(child2.verdict, "failed_verification"); // other.txt never produced - override really applied
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
      assert.equal(parent.verdict, "verified");
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
      assert.equal(childSpec.git_head_at_launch, parentHead);

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
      workdir: join(home, "none"), session_id: null, exit: "running", verdict: "pending",
      started_at: new Date(Date.now() - 60_000).toISOString(), ended_at: null,
      cost_usd: null, cost_basis: "unavailable", tokens_in: null, tokens_out: null,
      budget_usd: null, max_minutes: null, auth_mode: "api_key", gateway: null,
      pid: null, supervisor_pid: 999_999_999, stderr_path: join(home, "none.log"),
      artifacts: [], verify_evidence: null, notified: false,
    } as never);

    const res = spawnSync(process.execPath, [entry, "reap"], { encoding: "utf8", env: { ...process.env } });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes("reaped 1 lost"), res.stdout);
    const reaped = getRun(id)!;
    assert.equal(reaped.exit, "lost");
    assert.equal(reaped.notified, true);
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
      workdir: join(home, id), session_id: null, exit: "succeeded", verdict: "verified",
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      cost_usd: null, cost_basis: "unavailable", tokens_in: null, tokens_out: null,
      budget_usd: null, max_minutes: null, auth_mode: "api_key" as const, gateway: null,
      pid: null, supervisor_pid: null, stderr_path: join(home, `${id}.log`),
      artifacts: [], verify_evidence: null, notified: false,
      ...overrides,
    };
  }

  test("notify hook that never reads stdin does not crash a read command (EPIPE)", async () => {
    const { insertRun, getRun, updateRun } = await import("../src/core/db.ts");
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));
    const configPath = join(home, "config.toml");
    const original = readFileSync(configPath, "utf8");

    const id = "epipe1";
    // Large enough to exceed the OS pipe buffer (observed ~64KB on both
    // Linux and macOS): the write can't complete in one synchronous syscall,
    // so part of it queues and lands after the hook has already exited and
    // closed its end - the exact EPIPE window the fix guards. A realistic
    // payload (a short title, a 300-char error excerpt) rarely reaches that
    // size, but nothing stops a long title from doing so.
    insertRun(placeholderRun(id, { title: "x".repeat(300_000), notified: false }) as never);

    try {
      // A hook that exits immediately without ever reading stdin.
      writeFileSync(configPath, `[notify]\nexec = "exit 0"\n`);

      const ls = spawnSync(process.execPath, [entry, "ls"], { encoding: "utf8", env: { ...process.env } });
      assert.equal(ls.status, 0, ls.stderr); // must not crash with a raw EPIPE stack trace
      assert.ok(ls.stdout.includes(id), ls.stdout);

      // The bug reproduces on every future command touching the run (the
      // crash happens before `notified` flips), so a second, different read
      // command must also survive.
      const show = spawnSync(process.execPath, [entry, "show", id], {
        encoding: "utf8",
        env: { ...process.env },
        maxBuffer: 5 * 1024 * 1024,
      });
      assert.equal(show.status, 0, show.stderr);
      assert.ok(show.stdout.includes(id), show.stdout);

      // Exit 0 alone does not mean delivered: this hook never drained the
      // oversized payload, so the write failed (EPIPE) partway through. The
      // stdin error is captured as a delivery fact, not just swallowed - see
      // the dedicated truncated-read test below for the full assertion.
      assert.equal(getRun(id)!.notified, false);
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
    insertRun(placeholderRun(id, { exit: "failed", verdict: "failed_verification", notified: false }) as never);

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
});

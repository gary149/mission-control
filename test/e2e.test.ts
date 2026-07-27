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
    process.env.MC_PI_BIN = FIXTURE_PI;
    process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
    // Poison: resident on the host, must never reach a child (additive-from-empty env).
    process.env.OPENROUTER_API_KEY = "or-poison-not-real";
    process.env.HF_TOKEN = "hf-poison-not-real";
    for (const fixture of [FIXTURE, FIXTURE_CODEX, FIXTURE_PI]) chmodSync(fixture, 0o755);
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
    const kinds = eventsAfter(run.id, 0).map((e: any) => e.kind);
    for (const expected of ["started", "text", "tool_call", "cost_update", "verify_result", "notify_result", "exited"]) {
      assert.ok(kinds.includes(expected), `missing event kind ${expected} in ${kinds}`);
    }

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
    const { getRun } = await import("../src/core/db.ts");

    const run = launch(baseSpec({ prompt: "fail on purpose FAIL LEAK", artifacts: ["out.txt"] }) as never);
    const done = await waitTerminal(() => getRun(run.id));

    assert.equal(done.exit, "failed");
    assert.equal(done.verdict, "failed_verification");

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
      "run", "ls", "show", "tail", "kill", "harness ls",
      "--harness", "--model", "--cwd", "--artifact", "--visual",
      "--max-minutes", "--budget", "--gateway", "--api-key", "--spec",
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

  test("pi: subscription without a provider-prefixed model is refused (env-dependent defaults)", async () => {
    const { launch } = await import("../src/core/launch.ts");
    // Locally: the model-requirement error. CI (no ~/.pi): the no-login error. Both fail closed.
    assert.throws(
      () => launch(baseSpec({ harness: "pi", auth: { mode: "subscription" } }) as never),
      /pi requires --model|no resident pi login/,
    );
  });

  test("pi: api_key mode refused with an honest rationale", async () => {
    const { launch } = await import("../src/core/launch.ts");
    assert.throws(
      () => launch(baseSpec({ harness: "pi", auth: { mode: "api_key" } }) as never),
      /does not support auth mode "api_key"[\s\S]*auth\.json/,
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
});

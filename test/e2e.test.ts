import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-claude.ts", import.meta.url));
const FIXTURE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.ts", import.meta.url));
const FIXTURE_PI = fileURLToPath(new URL("./fixtures/fake-pi.ts", import.meta.url));

let home: string;

beforeAll(() => {
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

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

async function waitTerminal(getRun: () => any, timeoutMs = 20000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const run = getRun();
    if (run && !["queued", "running"].includes(run.exit)) return run;
    if (Date.now() - start > timeoutMs) throw new Error(`run did not terminate: ${JSON.stringify(run)}`);
    await Bun.sleep(200);
  }
}

function baseSpec(overrides: Record<string, unknown>) {
  return {
    harness: "claude-code",
    model: null,
    goal: "test goal",
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
  test("run -> verified -> notified, with cost and clean child env", async () => {
    const { launch } = await import("../src/core/launch");
    const { getRun, eventsAfter } = await import("../src/core/db");

    const envDump = join(home, "child-env.json");
    const run = launch(
      baseSpec({
        goal: `produce out.txt for the e2e test DUMPENV:${envDump}`,
        artifacts: ["out.txt"],
      }) as never,
    );
    expect(run.cost_basis).toBe("metered_reported");

    const done = await waitTerminal(() => getRun(run.id));
    expect(done.exit).toBe("succeeded");
    expect(done.verdict).toBe("verified");
    expect(done.supervisor_pid).toBeGreaterThan(0);
    expect(done.cost_usd).toBe(0.42);
    expect(done.tokens_in).toBe(1000);
    expect(done.tokens_out).toBe(250);
    expect(done.session_ref).toBe("fake-session-123");
    expect(existsSync(join(done.workdir, "out.txt"))).toBe(true);

    // Event stream has the normalized shape.
    const kinds = eventsAfter(run.id, 0).map((e: any) => e.kind);
    for (const expected of ["started", "text", "tool_call", "cost_update", "verify_result", "exited"]) {
      expect(kinds).toContain(expected);
    }

    // Notification fired with both axes and no credential plumbing.
    const payload = JSON.parse(readFileSync(join(home, "notified.json"), "utf8"));
    expect(payload.id).toBe(run.id);
    expect(payload.exit).toBe("succeeded");
    expect(payload.verdict).toBe("verified");
    expect(payload.auth_mode).toBe("api_key");
    expect(payload.gateway).toBeUndefined();

    // Env poisoning: the child got the one forwarded key and none of the residents.
    const childEnv = JSON.parse(readFileSync(envDump, "utf8"));
    expect(childEnv.ANTHROPIC_API_KEY).toBe("sk-test-not-real");
    expect(childEnv.OPENROUTER_API_KEY).toBeUndefined();
    expect(childEnv.HF_TOKEN).toBeUndefined();
    expect(childEnv.DISABLE_AUTOUPDATER).toBe("1");
  });

  test("failing run -> failed + failed_verification, secrets scrubbed from logs", async () => {
    const { launch } = await import("../src/core/launch");
    const { getRun } = await import("../src/core/db");

    const run = launch(baseSpec({ goal: "fail on purpose FAIL LEAK", artifacts: ["out.txt"] }) as never);
    const done = await waitTerminal(() => getRun(run.id));

    expect(done.exit).toBe("failed");
    expect(done.verdict).toBe("failed_verification");

    // The injected key was echoed to stderr by the CLI; the stored log must be scrubbed.
    const stderrLog = readFileSync(done.stderr_path, "utf8");
    expect(stderrLog).toContain("***");
    expect(stderrLog).not.toContain("sk-test-not-real");
  });

  test("visual run terminates at needs_human_look", async () => {
    const { launch } = await import("../src/core/launch");
    const { getRun } = await import("../src/core/db");

    const run = launch(baseSpec({ goal: "make something pretty", artifacts: ["out.txt"], visual: true }) as never);
    const done = await waitTerminal(() => getRun(run.id));
    expect(done.exit).toBe("succeeded");
    expect(done.verdict).toBe("needs_human_look");
  });

  test("run with no declared checks lands at unverifiable", async () => {
    const { launch } = await import("../src/core/launch");
    const { getRun } = await import("../src/core/db");

    const run = launch(baseSpec({ goal: "no artifacts declared" }) as never);
    const done = await waitTerminal(() => getRun(run.id));
    expect(done.exit).toBe("succeeded");
    expect(done.verdict).toBe("unverifiable");
  });

  test("preflight refuses --budget with adapter-correct advice in every mode", async () => {
    const { launch } = await import("../src/core/launch");

    // The claude-code-specific refusal fires first so the user is pointed at
    // --max-minutes directly, never bounced to --api-key (which also refuses).
    expect(() =>
      launch(
        baseSpec({
          model: "moonshotai/kimi-k3",
          budget_usd: 5,
          auth: { mode: "gateway", gateway: "openrouter" },
        }) as never,
      ),
    ).toThrow(/cannot be enforced.*--max-minutes/);
  });

  test("help covers every command and flag, and -h never launches a run", async () => {
    const entry = fileURLToPath(new URL("../src/mc.ts", import.meta.url));
    const help = Bun.spawnSync(["bun", entry, "help"], { env: { ...process.env } }).stdout.toString();
    for (const expected of [
      "run", "ls", "show", "tail", "kill", "harness ls",
      "--harness", "--model", "--cwd", "--artifact", "--visual",
      "--max-minutes", "--budget", "--gateway", "--api-key", "--spec",
      "subscription", "MC_HOME", "config.toml",
    ]) {
      expect(help).toContain(expected);
    }
    // `mc run -h` must print help, not launch a run with goal "-h".
    const runH = Bun.spawnSync(["bun", entry, "run", "-h"], { env: { ...process.env } });
    expect(runH.stdout.toString()).toContain("USAGE");
    expect(runH.exitCode).toBe(0);
  });

  test("codex: verified run, tokens without cost, scratch CODEX_HOME, clean env", async () => {
    const { launch } = await import("../src/core/launch");
    const { getRun } = await import("../src/core/db");
    process.env.OPENAI_API_KEY = "sk-codex-test-not-real";

    const envDump = join(home, "codex-env.json");
    const run = launch(
      baseSpec({
        harness: "codex",
        goal: `produce out.txt DUMPENV:${envDump}`,
        artifacts: ["out.txt"],
        auth: { mode: "api_key" },
      }) as never,
    );
    expect(run.cost_basis).toBe("unavailable");
    const done = await waitTerminal(() => getRun(run.id));
    expect(done.exit).toBe("succeeded");
    expect(done.verdict).toBe("verified");
    expect(done.session_ref).toBe("fake-thread-0001");
    expect(done.tokens_in).toBe(500);
    expect(done.tokens_out).toBe(80);
    expect(done.cost_usd).toBeNull(); // codex never reports dollars, any mode

    const childEnv = JSON.parse(readFileSync(envDump, "utf8"));
    expect(childEnv.OPENAI_API_KEY).toBe("sk-codex-test-not-real");
    expect(childEnv.CODEX_HOME).toContain("/codex-home"); // scratch, never ~/.codex
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(childEnv.OPENROUTER_API_KEY).toBeUndefined();
  });

  test("codex: --budget refused (no cost signal in any mode)", async () => {
    const { launch } = await import("../src/core/launch");
    expect(() =>
      launch(baseSpec({ harness: "codex", budget_usd: 5, auth: { mode: "api_key" } }) as never),
    ).toThrow(/--budget has no meaning/);
  });

  test("pi: verified run with ACCUMULATED per-turn cost and tokens (gateway mode)", async () => {
    const { launch } = await import("../src/core/launch");
    const { getRun } = await import("../src/core/db");

    const envDump = join(home, "pi-env.json");
    const run = launch(
      baseSpec({
        harness: "pi",
        model: "fake/model",
        goal: `produce out.txt DUMPENV:${envDump}`,
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    expect(run.cost_basis).toBe("metered_reported");
    const done = await waitTerminal(() => getRun(run.id));
    expect(done.exit).toBe("succeeded");
    expect(done.verdict).toBe("verified");
    expect(done.session_ref).toBe("019f0000-fake-7000-a000-000000000001");
    // Two turns at 0.001 each and (2000+1000)/(20+30) tokens - deltas must SUM.
    expect(done.cost_usd).toBeCloseTo(0.002, 5);
    expect(done.tokens_in).toBe(3000);
    expect(done.tokens_out).toBe(50);

    const childEnv = JSON.parse(readFileSync(envDump, "utf8"));
    expect(childEnv.OPENROUTER_API_KEY).toBe("or-poison-not-real"); // forwarded: it IS the gateway credential
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(childEnv.HF_TOKEN).toBeUndefined();
  });

  test("pi: --budget is enforceable mid-run (killed between turns on overspend)", async () => {
    const { launch } = await import("../src/core/launch");
    const { getRun, eventsAfter } = await import("../src/core/db");

    const run = launch(
      baseSpec({
        harness: "pi",
        model: "fake/model",
        goal: "spend too much OVERBUDGET",
        artifacts: ["out.txt"],
        budget_usd: 1,
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    const done = await waitTerminal(() => getRun(run.id));
    expect(done.exit).toBe("killed");
    const capEvents = eventsAfter(run.id, 0).filter(
      (e: any) => e.kind === "error" && e.payload?.note === "cap-exceeded",
    );
    expect(capEvents.length).toBe(1);
    expect(String((capEvents[0]!.payload as any).detail)).toContain("budget");
  });

  test("pi: subscription without a provider-prefixed model is refused (env-dependent defaults)", async () => {
    const { launch } = await import("../src/core/launch");
    // Locally: the model-requirement error. CI (no ~/.pi): the no-login error. Both fail closed.
    expect(() => launch(baseSpec({ harness: "pi", auth: { mode: "subscription" } }) as never)).toThrow(
      /pi requires --model|no resident pi login/,
    );
  });

  test("pi: api_key mode refused with an honest rationale", async () => {
    const { launch } = await import("../src/core/launch");
    expect(() => launch(baseSpec({ harness: "pi", auth: { mode: "api_key" } }) as never)).toThrow(
      /does not support auth mode "api_key".*auth\.json/,
    );
  });

  test("resume: linked run in the parent's workdir continuing the native session", async () => {
    const { launch } = await import("../src/core/launch");
    const { getRun } = await import("../src/core/db");

    const parentRun = launch(
      baseSpec({
        harness: "codex",
        goal: "first step: produce out.txt",
        artifacts: ["out.txt"],
        auth: { mode: "api_key" },
      }) as never,
    );
    const parent = await waitTerminal(() => getRun(parentRun.id));
    expect(parent.session_ref).toBe("fake-thread-0001");

    const resumed = launch(
      baseSpec({
        harness: "codex",
        goal: "second step: append",
        artifacts: ["out.txt"],
        auth: { mode: "api_key" },
      }) as never,
      { parent },
    );
    expect(resumed.parent_run_id).toBe(parent.id);
    expect(resumed.root_run_id).toBe(parent.root_run_id);
    expect(resumed.workdir).toBe(parent.workdir); // SAME worktree, not a new one

    const resumedDone = await waitTerminal(() => getRun(resumed.id));
    expect(resumedDone.exit).toBe("succeeded");
    expect(resumedDone.session_ref).toBe(parent.session_ref); // continued, not fresh
    const content = readFileSync(join(parent.workdir, "out.txt"), "utf8");
    expect(content).toContain("resumed OK"); // the fake appends only under exec resume
  });

  test("resume: refused for a parent without a session_ref", async () => {
    const { launch } = await import("../src/core/launch");
    const { getRun, updateRun } = await import("../src/core/db");
    const parentRun = launch(
      baseSpec({ harness: "codex", goal: "x", artifacts: ["out.txt"], auth: { mode: "api_key" } }) as never,
    );
    const parent = await waitTerminal(() => getRun(parentRun.id));
    updateRun(parent.id, { session_ref: null });
    expect(() =>
      launch(baseSpec({ harness: "codex", goal: "y", auth: { mode: "api_key" } }) as never, {
        parent: getRun(parent.id)!,
      }),
    ).toThrow(/no session reference/);
  });

  test("capability honesty: resume declarations are backed by real resume argv", async () => {
    const { ADAPTERS } = await import("../src/core/adapters/registry");
    for (const adapter of ADAPTERS) {
      if (adapter.capabilities.resume !== "native") continue;
      const { argv } = adapter.buildCommand({
        spec: baseSpec({ harness: adapter.name, auth: { mode: "api_key" } }) as never,
        binPath: "/bin/echo",
        workdir: join(home, "cap-check-work"),
        credential: { envVar: "X_KEY", value: "x-not-real-x" },
        resumeSession: "SESSION-REF-123",
      });
      expect(argv.join(" ")).toContain("SESSION-REF-123");
    }
  });

  test("TOML parser keeps '#' inside quoted values", async () => {
    const { loadConfig } = await import("../src/core/config");
    const { writeFileSync, readFileSync } = await import("node:fs");
    const configPath = join(home, "config.toml");
    const original = readFileSync(configPath, "utf8");
    try {
      writeFileSync(configPath, `[notify]\nwebhook = "https://example.com/hook?tag=a # not a comment"\n`);
      expect(loadConfig().notify.webhook).toBe("https://example.com/hook?tag=a # not a comment");
    } finally {
      writeFileSync(configPath, original);
    }
  });

  test("preflight refuses unknown gateway and non-prefixed model", async () => {
    const { launch } = await import("../src/core/launch");

    expect(() =>
      launch(baseSpec({ model: "a/b", auth: { mode: "gateway", gateway: "nope" } }) as never),
    ).toThrow(/unknown gateway/);

    expect(() =>
      launch(baseSpec({ model: "kimi-k3", auth: { mode: "gateway", gateway: "openrouter" } }) as never),
    ).toThrow(/provider-prefixed/);
  });

  test("gateway run wires the shim env, never leaks ANTHROPIC_API_KEY, never trusts the cost figure", async () => {
    const { launch } = await import("../src/core/launch");
    const { getRun } = await import("../src/core/db");

    const envDump = join(home, "gw-env.json");
    const run = launch(
      baseSpec({
        model: "moonshotai/kimi-k3",
        goal: `gateway wiring test DUMPENV:${envDump}`,
        artifacts: ["out.txt"],
        auth: { mode: "gateway", gateway: "openrouter" },
      }) as never,
    );
    const done = await waitTerminal(() => getRun(run.id));

    expect(done.cost_basis).toBe("unavailable");
    expect(done.cost_usd).toBeNull(); // the CLI's figure is unreliable under gateway; events keep it
    expect(done.tokens_in).toBe(1000); // tokens are the honest signal

    const childEnv = JSON.parse(readFileSync(envDump, "utf8"));
    expect(childEnv.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(childEnv.ANTHROPIC_AUTH_TOKEN).toBe("or-poison-not-real");
    expect(childEnv.ANTHROPIC_MODEL).toBe("moonshotai/kimi-k3");
    expect(childEnv.CLAUDE_CODE_SUBAGENT_MODEL).toBe("moonshotai/kimi-k3");
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("workspace containment refuses agent-state directories", async () => {
    const { launch } = await import("../src/core/launch");
    expect(() => launch(baseSpec({ cwd: join(process.env.HOME!, ".claude") }) as never)).toThrow(/agent-state/);
  });

  test("preflight refuses --budget on claude-code even when metered (terminal-only cost)", async () => {
    const { launch } = await import("../src/core/launch");
    expect(() => launch(baseSpec({ budget_usd: 5 }) as never)).toThrow(/cannot be enforced/);
  });

  test("preflight refuses artifact paths that escape the workdir", async () => {
    const { launch } = await import("../src/core/launch");
    expect(() => launch(baseSpec({ artifacts: ["../spec.json"] }) as never)).toThrow(/escapes the run workdir/);
    expect(() => launch(baseSpec({ artifacts: ["/etc/passwd"] }) as never)).toThrow(/escapes the run workdir/);
  });

  test("preflight refuses invalid cap values", async () => {
    const { launch } = await import("../src/core/launch");
    expect(() => launch(baseSpec({ max_minutes: -5 }) as never)).toThrow(/finite positive/);
    expect(() => launch(baseSpec({ max_minutes: Number.NaN }) as never)).toThrow(/finite positive/);
  });

  test("preflight refuses a non-git --cwd instead of silently hiding inputs", async () => {
    const { launch } = await import("../src/core/launch");
    const plainDir = mkdtempSync(join(tmpdir(), "mc-nongit-"));
    try {
      expect(() => launch(baseSpec({ cwd: plainDir }) as never)).toThrow(/not a git repository/);
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  test("unreadable native stream caps the verdict at unverifiable (parser health)", async () => {
    const { launch } = await import("../src/core/launch");
    const { getRun } = await import("../src/core/db");

    const run = launch(baseSpec({ goal: "drift simulation RAWLINES", artifacts: ["out.txt"] }) as never);
    const done = await waitTerminal(() => getRun(run.id));
    // Artifact exists and exit is 0, but mc was blind - never verified.
    expect(done.exit).toBe("succeeded");
    expect(done.verdict).toBe("unverifiable");
    expect(done.verify_evidence).toContain("parser_health");
  });
});

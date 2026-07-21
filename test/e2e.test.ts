import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-claude.ts", import.meta.url));

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "mc-test-"));
  process.env.MC_HOME = home;
  process.env.MC_CLAUDE_BIN = FIXTURE;
  process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
  // Poison: resident on the host, must never reach a child (additive-from-empty env).
  process.env.OPENROUTER_API_KEY = "or-poison-not-real";
  process.env.HF_TOKEN = "hf-poison-not-real";
  chmodSync(FIXTURE, 0o755);
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

import { ADAPTERS, getAdapter } from "./core/adapters/registry";
import { resolveAuth } from "./core/auth";
import { loadConfig } from "./core/config";
import { eventsAfter, findRun, listRuns, markLost, getRun, insertEvent } from "./core/db";
import { launch } from "./core/launch";
import { notifyTerminal } from "./core/notify";
import { PreflightError, type Run, type RunSpec } from "./core/types";

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

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
 * Terminal rows that never got their push (crash mid-delivery) are re-notified.
 */
async function reapLostRuns(runs: Run[]): Promise<Run[]> {
  const config = loadConfig();
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
    if (!isActive(current) && !current.notified) {
      await notifyTerminal(current, config);
      current = getRun(current.id) ?? current;
    }
    out.push(current);
  }
  return out;
}

function age(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
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
  let gateway: string | null = null;
  let apiKey = false;
  let visual = false;
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
    switch (arg) {
      case "--harness": harness = next(); break;
      case "--model": model = next(); break;
      case "--cwd": cwd = next(); break;
      case "--budget": budget = nextPositive(); break;
      case "--max-minutes": maxMinutes = nextPositive(); break;
      case "--gateway": gateway = next(); break;
      case "--api-key": apiKey = true; break;
      case "--visual": visual = true; break;
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
  const goal = positional.join(" ").trim();
  if (!goal) fail("a goal is required");

  return {
    spec: {
      harness,
      model,
      goal,
      cwd,
      artifacts,
      visual,
      budget_usd: budget,
      max_minutes: maxMinutes,
      auth: gateway ? { mode: "gateway", gateway } : apiKey ? { mode: "api_key" } : { mode: "subscription" },
    },
  };
}

async function readSpecFromStdin(): Promise<RunSpec> {
  const text = await new Response(Bun.stdin.stream()).text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`--spec -: stdin is not valid JSON`);
  }
  // Same fail-closed validation as the flag form - this is the remote-safe
  // surface, where a malformed payload is the most likely failure mode.
  if (typeof parsed?.harness !== "string" || !parsed.harness) fail(`--spec -: "harness" (string) is required`);
  if (typeof parsed?.goal !== "string" || !parsed.goal.trim()) fail(`--spec -: "goal" (string) is required`);
  return {
    harness: parsed.harness,
    model: parsed.model ?? null,
    goal: parsed.goal,
    cwd: parsed.cwd ?? null,
    artifacts: parsed.artifacts ?? [],
    visual: parsed.visual ?? false,
    budget_usd: parsed.budget_usd ?? null,
    max_minutes: parsed.max_minutes ?? null,
    auth: parsed.auth ?? { mode: "subscription" },
  };
}

export async function cliMain(argv: string[]): Promise<void> {
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
        const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
        for (const row of [header, ...rows]) {
          console.log(row.map((cell, i) => cell.padEnd(widths[i]!)).join("  "));
        }
        break;
      }

      case "show": {
        const run = (await reapLostRuns([requireRun(args[0])]))[0]!;
        console.log(JSON.stringify(run, null, 2));
        const recent = eventsAfter(run.id, 0).slice(-10);
        if (recent.length > 0) {
          console.log("\nlast events:");
          for (const event of recent) console.log(`  [${event.seq}] ${event.kind} ${JSON.stringify(event.payload).slice(0, 120)}`);
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
          const current = (await reapLostRuns([getRun(run.id)!]))[0]!;
          if (!["running", "queued"].includes(current.exit) && eventsAfter(run.id, seq).length === 0) {
            console.log(`-- terminal: exit=${current.exit} verdict=${current.verdict} --`);
            break;
          }
          await Bun.sleep(500);
        }
        break;
      }

      case "kill": {
        const run = requireRun(args[0]);
        if (run.exit !== "running") fail(`run ${run.id} is not running (exit=${run.exit})`);
        // Request only - the run stays `running` until the supervisor observes
        // the process actually die (close signal) and writes the terminal row.
        insertEvent(run.id, "status_change", { kill_requested: true, by: "mc kill" });
        if (run.pid) {
          try {
            process.kill(run.pid, "SIGTERM");
          } catch {
            /* already gone; reap on next ls */
          }
        }
        console.log(`kill requested for ${run.id} (mc tail ${run.id} to watch it land)`);
        break;
      }

      case "harness": {
        if (args[0] !== "ls") fail("usage: mc harness ls");
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
                harness: adapter.name, model: mode === "gateway" ? "probe/probe" : null, goal: "probe",
                cwd: null, artifacts: [], visual: false, budget_usd: null, max_minutes: null,
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

      case "help":
      case undefined:
        // MC_BUILD is inlined by the release build (--define); source runs show none.
        console.log(`mission-control v0${process.env.MC_BUILD ? ` (${process.env.MC_BUILD})` : ""}

usage:
  mc run --harness H [--model M] [--cwd DIR] [--gateway NAME | --api-key]
         [--budget N] [--max-minutes N] [--artifact PATH]... [--visual] "goal"
  mc run --spec -          # full RunSpec as JSON on stdin
  mc ls [--json]
  mc show <run-id>
  mc tail <run-id>
  mc kill <run-id>
  mc harness ls`);
        break;

      default:
        fail(`unknown command "${command}" (try: mc help)`);
    }
  } catch (error) {
    if (error instanceof PreflightError) fail(error.message);
    throw error;
  }
}

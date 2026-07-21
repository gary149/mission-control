import { spawn } from "node:child_process";
import type { McConfig } from "./config";
import { updateRun } from "./db";
import type { Run } from "./types";

/**
 * One push per terminal transition. Payload carries both status axes but no
 * credential-plumbing detail (SPEC: auth security invariants) - auth_mode only.
 */
export async function notifyTerminal(run: Run, config: McConfig): Promise<void> {
  if (run.notified) return;
  const payload = JSON.stringify({
    id: run.id,
    title: run.title,
    harness: run.harness,
    model: run.model,
    host: run.host,
    exit: run.exit,
    verdict: run.verdict,
    cost_usd: run.cost_usd,
    cost_basis: run.cost_basis,
    tokens_in: run.tokens_in,
    tokens_out: run.tokens_out,
    auth_mode: run.auth_mode,
    workdir: run.workdir,
    artifacts: run.artifacts,
    started_at: run.started_at,
    ended_at: run.ended_at,
  });

  // Deliver FIRST, mark notified LAST: a crash mid-delivery then re-notifies on
  // the next reap (at-least-once) instead of silently losing the push forever
  // (at-most-once is the exact lost-run failure mode the SPEC exists to kill).
  if (config.notify.exec) {
    await new Promise<void>((resolveWait) => {
      const child = spawn("sh", ["-c", config.notify.exec!], { stdio: ["pipe", "ignore", "ignore"] });
      // A hung hook must never pin the supervisor or block the webhook below.
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      const done = () => {
        clearTimeout(timer);
        resolveWait();
      };
      child.stdin.write(payload);
      child.stdin.end();
      child.on("close", done);
      child.on("error", done);
    });
  }

  if (config.notify.webhook) {
    try {
      await fetch(config.notify.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Delivery failure must never take the supervisor down with it.
    }
  }

  updateRun(run.id, { notified: true });
}

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

  updateRun(run.id, { notified: true });

  if (config.notify.exec) {
    await new Promise<void>((resolveWait) => {
      const child = spawn("sh", ["-c", config.notify.exec!], { stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.write(payload);
      child.stdin.end();
      child.on("close", () => resolveWait());
      child.on("error", () => resolveWait());
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
}

import { spawn } from "node:child_process";
import { insertEvent, updateRun } from "./db.js";
/**
 * One push per terminal transition. Payload carries both status axes but no
 * credential-plumbing detail (SPEC: auth security invariants) - auth_mode only.
 *
 * `notified` means "the delivery obligation was discharged", not "someone was
 * told": the per-channel truth (including "no hooks configured") is recorded
 * as a notify_result event so the ledger never implies delivery that did not
 * happen (fleet evidence: both boxes ran for days with zero hooks configured
 * and every run stamped notified=true).
 */
export async function notifyTerminal(run, config) {
    if (run.notified)
        return;
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
    const channels = {};
    // Deliver FIRST, mark notified LAST: a crash mid-delivery then re-notifies on
    // the next reap (at-least-once) instead of silently losing the push forever
    // (at-most-once is the exact lost-run failure mode the SPEC exists to kill).
    if (config.notify.exec) {
        channels.exec = await new Promise((resolveWait) => {
            const child = spawn("sh", ["-c", config.notify.exec], { stdio: ["pipe", "ignore", "ignore"] });
            // A hung hook must never pin the supervisor or block the webhook below.
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
            }, 15_000);
            child.stdin.write(payload);
            child.stdin.end();
            child.on("close", (code) => {
                clearTimeout(timer);
                resolveWait(timedOut ? { delivered: false, error: "timeout" } : { delivered: code === 0, exit_code: code });
            });
            child.on("error", (error) => {
                clearTimeout(timer);
                resolveWait({ delivered: false, error: String(error) });
            });
        });
    }
    if (config.notify.webhook) {
        try {
            const res = await fetch(config.notify.webhook, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: payload,
                signal: AbortSignal.timeout(15_000),
            });
            channels.webhook = { delivered: res.ok, status: res.status };
        }
        catch (error) {
            // Delivery failure must never take the supervisor down with it.
            channels.webhook = { delivered: false, error: String(error) };
        }
    }
    const configured = Object.keys(channels);
    insertEvent(run.id, "notify_result", {
        configured,
        channels: configured.length > 0 ? channels : undefined,
        note: configured.length === 0 ? "no notify hooks configured; nothing was delivered" : undefined,
    });
    updateRun(run.id, { notified: true });
}

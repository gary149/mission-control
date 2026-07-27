import { spawn } from "node:child_process";
import { claimNotify, eventsAfter, insertEvent, updateRun } from "./db.js";
/**
 * One push per terminal transition. Payload carries both status axes but no
 * credential-plumbing detail (SPEC: auth security invariants) - auth_mode only.
 *
 * `notified` means "the delivery obligation was discharged": at least one
 * configured channel reported delivered:true, OR zero channels are
 * configured at all (nothing to deliver - preserve the "obligation
 * discharged" reading for the no-hooks case; fleet evidence: both boxes ran
 * for days with zero hooks configured and every run stamped notified=true).
 * The per-channel truth (including "no hooks configured") is always recorded
 * as a notify_result event so the ledger never implies delivery that did not
 * happen.
 *
 * Dispatch ordering, and why it changed from "deliver first, mark last":
 * claimNotify() runs BEFORE dispatch, not after. Two callers can race on the
 * same terminal run (the supervisor's own exit path vs a concurrent `mc reap`
 * or an `mc ls`/`show`/`tail` read command's inline reap) - without an
 * atomic claim taken up front, both would read notified=false and both would
 * invoke the hook. Only the claim winner dispatches; the loser returns
 * immediately having sent nothing (see db.ts's claimNotify, which mirrors
 * markLost's compare-and-swap). That inverts the old ordering, trading one
 * gap for another: a hard kill between the claim and dispatch finishing
 * leaves the claim set with nothing delivered (a narrow, accepted window -
 * this tool deliberately does not build a full outbox to close it; SIGKILL
 * mid-dispatch was never fully safe here even under the old ordering). What
 * the new ordering buys is the SPEC's no-poll contract: if every configured
 * channel fails (a one-shot webhook 500, an exec hook that isn't running),
 * the claim is released (notified -> false) below so the next `mc reap`
 * retries delivery, instead of leaving an orchestrator that honors "do not
 * poll" waiting forever on a run that will never fire again.
 */
export async function notifyTerminal(run, config) {
    if (!claimNotify(run.id))
        return;
    // The push carries the failure REASON, not just the fact: exit_code from the
    // exited event (null for lost runs, which never wrote one) and the last
    // harness-error / stderr-tail / cap-exceeded excerpt when the run failed -
    // so an orchestrator need not round-trip through mc show to learn why.
    const events = eventsAfter(run.id, 0);
    const exited = [...events].reverse().find((e) => e.kind === "exited");
    const exitCode = exited?.payload?.exit_code ?? null;
    let errorExcerpt = null;
    if (run.exit !== "succeeded") {
        const err = [...events]
            .reverse()
            .find((e) => e.kind === "error" &&
            ["harness-error", "stderr-tail", "cap-exceeded"].includes(String(e.payload?.note)));
        if (err) {
            const p = err.payload;
            errorExcerpt = String(p.message ?? p.excerpt ?? p.detail ?? p.raw ?? "").slice(0, 300) || null;
        }
    }
    const payload = JSON.stringify({
        id: run.id,
        title: run.title,
        harness: run.harness,
        model: run.model,
        host: run.host,
        exit: run.exit,
        exit_code: exitCode,
        verdict: run.verdict,
        error: errorExcerpt,
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
    if (config.notify.exec) {
        channels.exec = await new Promise((resolveWait) => {
            const child = spawn("sh", ["-c", config.notify.exec], { stdio: ["pipe", "ignore", "ignore"] });
            // A hook that exits without draining stdin makes the write below raise
            // EPIPE. An 'error' event on an EventEmitter with no listener is fatal
            // to the WHOLE process (not just this promise) - and since it happens
            // before the claim above can be released, the same crash would
            // reproduce on every future command that touches this run. Mirrors the
            // child.on("error", ...) guard below, which covers spawn-time failures.
            //
            // A stdin error is also a DELIVERY fact, not just a crash to swallow: it
            // means the hook process did not receive the full payload (it closed
            // its read end, or otherwise refused the write, before we finished
            // sending). A hook that reads a few bytes then exits 0 would otherwise
            // be recorded delivered:true from the exit code alone - the payload
            // never actually arrived, so `notified` must not flip true and fix 2's
            // retry must fire.
            let stdinFailed = false;
            child.stdin.on("error", () => {
                stdinFailed = true;
            });
            // A hung hook must never pin the supervisor or block the webhook below.
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
            }, 15_000);
            try {
                // write()/end() do not throw synchronously for EPIPE in practice (it
                // surfaces via the 'error' event above), but guard the call itself
                // too rather than relying on that alone.
                child.stdin.write(payload);
                child.stdin.end();
            }
            catch {
                stdinFailed = true; // same fact, just observed synchronously
            }
            child.on("close", (code) => {
                clearTimeout(timer);
                resolveWait(timedOut
                    ? { delivered: false, error: "timeout" }
                    : stdinFailed
                        ? { delivered: false, error: "stdin write failed; payload not fully sent", exit_code: code }
                        : { delivered: code === 0, exit_code: code });
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
    const delivered = configured.some((name) => Boolean(channels[name]?.delivered));
    insertEvent(run.id, "notify_result", {
        configured,
        channels: configured.length > 0 ? channels : undefined,
        note: configured.length === 0
            ? "no notify hooks configured; nothing was delivered"
            : delivered
                ? undefined
                : "all configured channels failed delivery; notify claim released for retry",
    });
    // The claim taken at the top already set notified=1 for the "obligation
    // discharged" cases (delivered, or nothing configured). Only release it
    // when channels were configured AND every one of them failed - that is the
    // one case where the obligation was NOT discharged, and the SPEC's no-poll
    // contract needs the next `mc reap` to see notified=false and try again.
    if (configured.length > 0 && !delivered)
        updateRun(run.id, { notified: false });
}

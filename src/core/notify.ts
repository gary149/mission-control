import { spawn } from "node:child_process";
import type { McConfig, NotifyTarget } from "./config.ts";
import { claimAssessmentNotify, claimNotify, eventsAfter, insertEvent, setAssessmentNotified, updateRun } from "./db.ts";
import type { Assessment, Run } from "./types.ts";

/**
 * Deliver `payload` to whichever channels `target` configures (exec and/or
 * webhook). This is the ONE delivery mechanism in mc - stdin-fully-read
 * semantics, EPIPE handling, timeouts, webhook POST - shared by every caller
 * that pushes JSON somewhere: `notifyTerminal` (run payloads),
 * `notifyAssessment` (assessment payloads), and `sendTest` (`mc init`'s
 * synthetic verification push). None of them duplicate this logic; they only
 * differ in what payload they build and what they do with the result.
 *
 * Returns one entry per CONFIGURED channel only - an unconfigured channel is
 * simply absent from the result, never a false/error entry standing in for
 * "not configured".
 */
async function dispatch(payload: string, target: NotifyTarget): Promise<Record<string, unknown>> {
  const channels: Record<string, unknown> = {};

  if (target.exec) {
    channels.exec = await new Promise<unknown>((resolveWait) => {
      const child = spawn("sh", ["-c", target.exec!], { stdio: ["pipe", "ignore", "ignore"] });
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
      // never actually arrived, so `notified` must not flip true and the
      // retry (via `mc reap`) must fire.
      let stdinFailed = false;
      child.stdin.on("error", () => {
        stdinFailed = true;
      });
      // A hung hook must never pin the caller or block the webhook below.
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
      } catch {
        stdinFailed = true; // same fact, just observed synchronously
      }
      child.on("close", (code) => {
        clearTimeout(timer);
        resolveWait(
          timedOut
            ? { delivered: false, error: "timeout" }
            : stdinFailed
              ? { delivered: false, error: "stdin write failed; payload not fully sent", exit_code: code }
              : { delivered: code === 0, exit_code: code },
        );
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolveWait({ delivered: false, error: String(error) });
      });
    });
  }

  if (target.webhook) {
    try {
      const res = await fetch(target.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(15_000),
      });
      channels.webhook = { delivered: res.ok, status: res.status };
    } catch (error) {
      // Delivery failure must never take the caller down with it.
      channels.webhook = { delivered: false, error: String(error) };
    }
  }

  return channels;
}

function anyDelivered(channels: Record<string, unknown>): boolean {
  return Object.keys(channels).some((name) => Boolean((channels[name] as { delivered?: boolean } | undefined)?.delivered));
}

/**
 * One push per terminal transition. Payload carries `exit` and, when the run
 * didn't succeed, why - but no credential-plumbing detail (SPEC: auth
 * security invariants) - auth_mode only.
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
export async function notifyTerminal(run: Run, config: McConfig): Promise<void> {
  if (!claimNotify(run.id)) return;
  // The push carries the failure REASON, not just the fact: exit_code from the
  // exited event (null for lost runs, which never wrote one) and the last
  // harness-error / stderr-tail / cap-exceeded excerpt when the run failed -
  // so an orchestrator need not round-trip through mc show to learn why.
  const events = eventsAfter(run.id, 0);
  const exited = [...events].reverse().find((e) => e.kind === "exited");
  const exitCode = (exited?.payload as { exit_code?: number | null } | undefined)?.exit_code ?? null;
  let errorExcerpt: string | null = null;
  if (run.exit !== "succeeded") {
    const err = [...events]
      .reverse()
      .find(
        (e) =>
          e.kind === "error" &&
          ["harness-error", "stderr-tail", "cap-exceeded"].includes(String((e.payload as { note?: string } | null)?.note)),
      );
    if (err) {
      const p = err.payload as { message?: string; excerpt?: string; detail?: string; raw?: string };
      errorExcerpt = String(p.message ?? p.excerpt ?? p.detail ?? p.raw ?? "").slice(0, 300) || null;
    } else {
      // A `lost` run has no error-kind event - its supervisor died before one
      // could be emitted. Reap records why on the exited event's `note`; surface
      // it so an abandoned run's push still explains itself, not just "lost".
      const note = (exited?.payload as { note?: string } | undefined)?.note;
      if (note) errorExcerpt = String(note).slice(0, 300);
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

  const channels = await dispatch(payload, config.notify);
  const configured = Object.keys(channels);
  const delivered = anyDelivered(channels);
  insertEvent(run.id, "notify_result", {
    configured,
    channels: configured.length > 0 ? channels : undefined,
    note:
      configured.length === 0
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
  if (configured.length > 0 && !delivered) updateRun(run.id, { notified: false });
}

/**
 * Assessment receipts get their OWN delivery seam - config's
 * `[notify.assessment]`, never the top-level `[notify]` used by
 * notifyTerminal above. This is deliberate, not an oversight: `[notify]`
 * payloads assume a terminal RUN shape, and an integration built against
 * that shape (reading `.exit`, `.cost_usd`, ...) could misfire if an
 * assessment payload - `{topic, run, assessment}` - arrived on the same
 * hook. Keeping them separate means an operator who only wants run
 * completion pushes never has to filter out assessment noise, and vice
 * versa.
 *
 * Delivery truth lives in db.ts's separate `assessment_notifications` table
 * (keyed run_id + assessment seq), NOT a `notified` column on the assessment
 * row itself - see that table's comment for why: a mutable delivery flag on
 * `assessments` would UPDATE a judgment row in place on every claim/release,
 * which would make that table not genuinely append-only. claimAssessmentNotify
 * / setAssessmentNotified are the only things that ever touch it, with the
 * identical stdin-fully-read/exit-0 semantics as notifyTerminal - both go
 * through the same `dispatch` above. `mc reap` retries any assessment still
 * undelivered the same way it retries failed run notifications.
 */
export async function notifyAssessment(run: Run, assessment: Assessment, config: McConfig): Promise<void> {
  if (!claimAssessmentNotify(run.id, assessment.seq)) return;
  const payload = JSON.stringify({ topic: "assessment_recorded", run, assessment });
  const channels = await dispatch(payload, config.notify.assessment);
  const configured = Object.keys(channels);
  // Same "obligation discharged" reading as notifyTerminal: nothing
  // configured, or at least one channel delivered, both count as settled and
  // keep notified=1 from the claim above. A total failure releases the claim.
  if (configured.length > 0 && !anyDelivered(channels)) {
    setAssessmentNotified(run.id, assessment.seq, false);
  }
}

/**
 * `mc init`'s verify-not-assume step and `mc init --check`'s dry diagnosis
 * both need "did this hook actually work" without any run/assessment to hang
 * the payload off - a synthetic, clearly-marked payload distinguishes this
 * from a real push on the receiving end. Reuses the identical dispatch
 * mechanics as every real notification, so a hook that passes this check has
 * been exercised the same way it will be exercised for real.
 */
export async function sendTest(target: NotifyTarget): Promise<boolean> {
  const payload = JSON.stringify({ test: true, note: "mc init verification" });
  const channels = await dispatch(payload, target);
  return anyDelivered(channels);
}

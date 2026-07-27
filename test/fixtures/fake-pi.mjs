#!/usr/bin/env node
/**
 * Stub pi for the conformance suite. Emits the -p --mode json JSONL shape
 * captured VERBATIM from pi 0.81.0 on 2026-07-22 (two turns, so the per-turn
 * cost/token DELTAS must accumulate). Prompt directives: FAIL, DUMPENV:<p>,
 * OVERBUDGET (inflate per-turn cost to trip a --budget cap), SOFTFAIL
 * (terminal turn_end with stopReason "error" but process exit 0 - pi's real
 * false-green shape, confirmed live: print-mode.js never sets a non-zero
 * exit code in `--mode json`, only in `--mode text`), ABORTFAIL (same shape,
 * stopReason "aborted" - the other terminal-failure StopReason), NOISYEVENTS
 * (emit the real-but-previously-unmapped queue_update/compaction/auto_retry
 * events).
 * `--session <id>` simulates native resume by appending to the target file.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("9.9.9 (fake-pi)");
  process.exit(0);
}

const sessionFlag = args.indexOf("--session");
const resumeId = sessionFlag >= 0 ? args[sessionFlag + 1] : null;
const prompt = args[args.length - 1] ?? "";

const dumpMatch = prompt.match(/DUMPENV:(\S+)/);
if (dumpMatch) writeFileSync(dumpMatch[1], JSON.stringify(process.env, null, 2));

const emit = (obj) => console.log(JSON.stringify(obj));
const sessionId = resumeId ?? "019f0000-fake-7000-a000-000000000001";
const perTurnCost = prompt.includes("OVERBUDGET") ? 3.5 : 0.001;

const usage = (input, output) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: input + output,
  cost: { input: perTurnCost / 2, output: perTurnCost / 2, cacheRead: 0, cacheWrite: 0, total: perTurnCost },
});

emit({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() });
emit({ type: "agent_start" });

if (prompt.includes("NOISYEVENTS")) {
  // Real members of pi's AgentSessionEvent union (compaction, retries, the
  // steering/follow-up queue) - must stay benign, never poison parser health.
  emit({ type: "queue_update", steering: [], followUp: [] });
  emit({ type: "compaction_start", reason: "threshold" });
  emit({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
  emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: "rate limited" });
  emit({ type: "auto_retry_end", success: true, attempt: 1 });
}

if (prompt.includes("SOFTFAIL")) {
  // pi's real false-green shape: the final turn errors out, but `--mode json`
  // never sets a non-zero process exit code for it (unlike `--mode text`).
  // The artifact is still written first - present-but-irrelevant, since a
  // failed terminal turn must fail the run regardless of what's on disk.
  writeFileSync("out.txt", "deliverable content\n");
  emit({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [],
      provider: "openrouter",
      model: "fake/model",
      usage: usage(400, 5),
      stopReason: "error",
      errorMessage: "simulated soft failure: process exits 0 anyway",
    },
  });
  emit({ type: "agent_end" });
  process.exit(0);
}

if (prompt.includes("ABORTFAIL")) {
  // Same false-green shape as SOFTFAIL, stopReason "aborted" instead of
  // "error" - both terminal StopReasons must be treated as a failed turn,
  // and both must still carry their `usage` into cost/token accounting.
  writeFileSync("out.txt", "deliverable content\n");
  emit({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [],
      provider: "openrouter",
      model: "fake/model",
      usage: usage(300, 7),
      stopReason: "aborted",
      errorMessage: "simulated abort: process exits 0 anyway",
    },
  });
  emit({ type: "agent_end" });
  process.exit(0);
}

emit({ type: "turn_start" });
emit({ type: "toolcall_end", toolCall: { id: "call_1", name: "write", arguments: { path: "out.txt" } } });
emit({ type: "tool_execution_start", id: "call_1" });
// Streaming progress emitted mid-tool by real pi (observed live in run 92100d);
// must be benign - it silently capped a real run at unverifiable before.
emit({ type: "tool_execution_update", id: "call_1", output: "..." });
emit({ type: "tool_execution_end", result: "ok" });
emit({
  type: "turn_end",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "write", arguments: { path: "out.txt" } }],
    provider: "openrouter",
    model: "fake/model",
    usage: usage(2000, 20),
    stopReason: "toolUse",
  },
});

if (prompt.includes("FAIL")) {
  emit({ type: "error", error: "simulated failure" });
  process.exit(1);
}

if (resumeId) appendFileSync("out.txt", "resumed OK\n");
else writeFileSync("out.txt", "deliverable content\n");

emit({ type: "turn_start" });
emit({
  type: "turn_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    provider: "openrouter",
    model: "fake/model",
    usage: usage(1000, 30),
    stopReason: "stop",
  },
});
emit({ type: "agent_end" });

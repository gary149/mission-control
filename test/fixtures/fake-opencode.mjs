#!/usr/bin/env node
/**
 * Stub opencode for the conformance suite. Emits the `run --format json --auto`
 * envelope shape captured VERBATIM from opencode 1.18.7 on 2026-07-27 (live
 * probe on the openclaw host via OpenRouter): {type, timestamp, sessionID, part}
 * per line, sessionID on every envelope, step_finish carrying PER-STEP DELTA
 * cost/tokens, no explicit done event. Two steps (tool step + text step) so the
 * per-step deltas must accumulate. Failure mode (probed live): a single error
 * envelope, exit 1. Prompt directives: FAIL, DUMPENV:<path>, OVERBUDGET
 * (inflate per-step cost to trip --budget). `-s <id>` simulates native resume
 * by appending to out.txt and re-emitting the SAME session id.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("1.18.7 (fake-opencode)");
  process.exit(0);
}

const sessionFlag = args.indexOf("-s");
const resumeId = sessionFlag >= 0 ? args[sessionFlag + 1] : null;
const prompt = args[args.length - 1] ?? "";

const dumpMatch = prompt.match(/DUMPENV:(\S+)/);
if (dumpMatch) writeFileSync(dumpMatch[1], JSON.stringify(process.env, null, 2));

const emit = (obj) => console.log(JSON.stringify(obj));
const sessionID = resumeId ?? "ses_fake05772ffeXi7yksg5cygHR7";
const envelope = (type, data) => ({ type, timestamp: Date.now(), sessionID, ...data });
const stepCost = prompt.includes("OVERBUDGET") ? 3.5 : 0.0216654;

emit(envelope("step_start", { part: { id: "prt_1", messageID: "msg_1", sessionID, type: "step-start" } }));
emit(envelope("tool_use", {
  part: {
    type: "tool", tool: "write", callID: "write_0",
    state: {
      status: "completed",
      input: { filePath: "out.txt", content: "deliverable content\n" },
      output: "Wrote file successfully.",
      metadata: {}, title: "out.txt", time: { start: 1, end: 2 },
    },
    id: "prt_2", sessionID, messageID: "msg_1",
  },
}));
if (resumeId) appendFileSync("out.txt", "resumed OK\n");
else writeFileSync("out.txt", "deliverable content\n");
emit(envelope("step_finish", {
  part: {
    id: "prt_3", reason: "tool-calls", messageID: "msg_1", sessionID, type: "step-finish",
    tokens: { total: 8633, input: 6477, output: 76, reasoning: 32, cache: { write: 0, read: 2048 } },
    cost: stepCost,
  },
}));

if (prompt.includes("FAIL")) {
  emit(envelope("error", { error: { name: "UnknownError", data: { message: "Unexpected server error. Check server logs for details.", ref: "err_fake0001" } } }));
  process.exit(1);
}

emit(envelope("step_start", { part: { id: "prt_4", messageID: "msg_2", sessionID, type: "step-start" } }));
emit(envelope("text", {
  part: { id: "prt_5", messageID: "msg_2", sessionID, type: "text", text: "Created out.txt containing exactly one line: deliverable content.", time: { start: 3, end: 4 } },
}));
emit(envelope("step_finish", {
  part: {
    id: "prt_6", reason: "stop", messageID: "msg_2", sessionID, type: "step-finish",
    tokens: { total: 8866, input: 621, output: 27, reasoning: 26, cache: { write: 0, read: 8192 } },
    cost: prompt.includes("OVERBUDGET") ? 3.5 : 0.0055986,
  },
}));

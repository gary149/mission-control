#!/usr/bin/env node
/**
 * Stub pi for the conformance suite. Emits the -p --mode json JSONL shape
 * captured VERBATIM from pi 0.81.0 on 2026-07-22 (two turns, so the per-turn
 * cost/token DELTAS must accumulate). Prompt directives: FAIL, DUMPENV:<p>,
 * OVERBUDGET (inflate per-turn cost to trip a --budget cap).
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
emit({ type: "turn_start" });
emit({ type: "toolcall_end", toolCall: { id: "call_1", name: "write", arguments: { path: "out.txt" } } });
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

#!/usr/bin/env node
/**
 * Stub harness for the conformance/e2e suite: emits claude-code stream-json
 * shaped output without any network or API cost.
 *
 * Control directives arrive IN THE PROMPT (the last argv), because mission-
 * control strips the child env by design, so env-based control would never
 * reach this process:
 *   FAIL           exit 1 without writing the artifact
 *   LEAK           echo the received credential to stderr (scrub test)
 *   SLEEP:<ms>     linger before the result line (kill/timeout tests)
 *   DUMPENV:<path> write the full received env as JSON (poison test)
 */
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("9.9.9 (fake-claude)");
  process.exit(0);
}

const prompt = args[args.length - 1] ?? "";
const dumpMatch = prompt.match(/DUMPENV:(\S+)/);
if (dumpMatch) {
  writeFileSync(dumpMatch[1], JSON.stringify(process.env, null, 2));
}

// RAWLINES: emit an unreadable native stream (format-drift simulation) - the
// artifact appears and exit is 0, but no valid event ever parsed.
if (prompt.includes("RAWLINES")) {
  console.log("this is not json at all");
  console.log("neither is this line");
  writeFileSync("out.txt", "deliverable content\n");
  process.exit(0);
}

const emit = (obj) => console.log(JSON.stringify(obj));

emit({ type: "system", subtype: "init", session_id: "fake-session-123", model: "fake-model" });
// Benign native noise observed on real runs - must not trip parser health:
emit({ type: "system", subtype: "hook_started", hook_name: "SessionStart" });
emit({ type: "system", subtype: "thinking_tokens", tokens: 42 });
emit({ type: "system", subtype: "api_retry", attempt: 1 });
emit({ type: "assistant", message: { content: [{ type: "thinking", thinking: "..." }] } });
emit({ type: "assistant", message: { content: [{ type: "text", text: "Working on it." }] } });
emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "out.txt" } }] } });

if (prompt.includes("LEAK")) {
  const secret = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "none";
  console.error(`auth failed: Authorization: Bearer ${secret}`);
}

const sleepMatch = prompt.match(/SLEEP:(\d+)/);
if (sleepMatch) {
  await sleep(Number(sleepMatch[1]));
}

if (prompt.includes("FAIL")) {
  emit({ type: "result", subtype: "error_during_execution", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 2 } });
  process.exit(1);
}

writeFileSync("out.txt", "deliverable content\n");
emit({
  type: "result",
  subtype: "success",
  total_cost_usd: 0.42,
  usage: { input_tokens: 1000, output_tokens: 250 },
  num_turns: 3,
  result: "Done.",
  session_id: "fake-session-123",
});

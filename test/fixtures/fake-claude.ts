#!/usr/bin/env bun
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

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("9.9.9 (fake-claude)");
  process.exit(0);
}

const prompt = args[args.length - 1] ?? "";
const dumpMatch = prompt.match(/DUMPENV:(\S+)/);
if (dumpMatch) {
  writeFileSync(dumpMatch[1]!, JSON.stringify(process.env, null, 2));
}

const emit = (obj: unknown) => console.log(JSON.stringify(obj));

emit({ type: "system", subtype: "init", session_id: "fake-session-123", model: "fake-model" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "Working on it." }] } });
emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "out.txt" } }] } });

if (prompt.includes("LEAK")) {
  const secret = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "none";
  console.error(`auth failed: Authorization: Bearer ${secret}`);
}

const sleepMatch = prompt.match(/SLEEP:(\d+)/);
if (sleepMatch) {
  await Bun.sleep(Number(sleepMatch[1]));
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

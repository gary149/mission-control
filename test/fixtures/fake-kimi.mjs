#!/usr/bin/env node
/**
 * Stub kimi for the conformance suite. Emits the `-p --output-format stream-json`
 * JSONL shape captured VERBATIM from kimi-code 0.29.2 on 2026-07-27 (live probe
 * on the openclaw host via OpenRouter). Notable stream facts this fixture
 * preserves: no session-start event, no turn-complete event, no token/cost
 * telemetry; the trailing session.resume_hint is the only end-of-run marker.
 * Failure mode (probed live): exit 1 with an EMPTY stdout, error on stderr.
 * Prompt directives: FAIL, DUMPENV:<path>. `--session <id>` simulates native
 * resume by appending to out.txt and re-emitting the SAME session id.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("0.29.2 (fake-kimi)");
  process.exit(0);
}

const promptFlag = args.indexOf("-p");
const prompt = promptFlag >= 0 ? (args[promptFlag + 1] ?? "") : "";
const sessionFlag = args.indexOf("--session");
const resumeId = sessionFlag >= 0 ? args[sessionFlag + 1] : null;

const dumpMatch = prompt.match(/DUMPENV:(\S+)/);
if (dumpMatch) writeFileSync(dumpMatch[1], JSON.stringify(process.env, null, 2));

if (prompt.includes("FAIL")) {
  // Real kimi-code prints NOTHING to stdout on a failed headless run.
  console.error("error: failed to run prompt: provider.api_error: simulated failure");
  process.exit(1);
}

const emit = (obj) => console.log(JSON.stringify(obj));
const sessionId = resumeId ?? "session_fake0000-f0a6-4d76-811d-35e6a1e7559e";

// Shape from prompt-render.ts (PromptJsonRetryMetaMessage); must stay benign
// noise, never an unknown-native-event that poisons parser health.
emit({
  role: "meta", type: "turn.step.retrying",
  failed_attempt: 1, next_attempt: 2, max_attempts: 3, delay_ms: 1000,
  error_name: "APIError", error_message: "simulated transient upstream error", status_code: 429,
});
emit({
  role: "assistant",
  tool_calls: [
    { type: "function", id: "Write_0", function: { name: "Write", arguments: '{"path":"out.txt","content":"deliverable content\\n"}' } },
  ],
});
if (resumeId) appendFileSync("out.txt", "resumed OK\n");
else writeFileSync("out.txt", "deliverable content\n");
emit({ role: "tool", tool_call_id: "Write_0", content: "Wrote 20 bytes to out.txt" });
emit({ role: "assistant", content: "Created out.txt containing exactly one line: deliverable content." });
emit({
  role: "meta", type: "session.resume_hint",
  session_id: sessionId,
  command: `kimi -r ${sessionId}`,
  content: `To resume this session: kimi -r ${sessionId}`,
});

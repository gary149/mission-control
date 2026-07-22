#!/usr/bin/env bun
/**
 * Stub codex for the conformance suite. Emits the exec --json JSONL shape
 * captured VERBATIM from codex-cli 0.144.6 on 2026-07-22 (see the adapter's
 * doc comment). Prompt directives (env is stripped by design): FAIL, DUMPENV:<p>.
 * When invoked as `exec resume <id> <prompt>`, appends to the target file to
 * simulate native session continuation.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("codex-cli 9.9.9 (fake)");
  process.exit(0);
}

const isResume = args[0] === "exec" && args[1] === "resume";
const resumeId = isResume ? args[2] : null;
const prompt = args[args.length - 1] ?? "";

const dumpMatch = prompt.match(/DUMPENV:(\S+)/);
if (dumpMatch) writeFileSync(dumpMatch[1]!, JSON.stringify(process.env, null, 2));

const emit = (obj: unknown) => console.log(JSON.stringify(obj));
const threadId = resumeId ?? "fake-thread-0001";

emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });
emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "On it." } });
emit({
  type: "item.started",
  item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'echo hi'", aggregated_output: "", exit_code: null, status: "in_progress" },
});
emit({
  type: "item.completed",
  item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'echo hi'", aggregated_output: "hi\n", exit_code: 0, status: "completed" },
});

if (prompt.includes("FAIL")) {
  emit({ type: "turn.failed", error: "simulated failure" });
  process.exit(1);
}

if (isResume) appendFileSync("out.txt", "resumed OK\n");
else writeFileSync("out.txt", "deliverable content\n");

emit({
  type: "turn.completed",
  usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 80, reasoning_output_tokens: 10 },
});

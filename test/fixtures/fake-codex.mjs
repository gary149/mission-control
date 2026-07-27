#!/usr/bin/env node
/**
 * Stub codex for the conformance suite. Emits the exec --json JSONL shape
 * captured VERBATIM from codex-cli 0.144.6 on 2026-07-22 (see the adapter's
 * doc comment). Prompt directives (env is stripped by design): FAIL, DUMPENV:<p>,
 * MCPTOOLS (emit mcp_tool_call/web_search items - real codex SDK item types
 * confirmed against the installed @openai/codex 0.145.0 binary's item-type
 * enum, previously unmapped and parser-health-poisoning), MKDIRARTIFACT
 * (mkdir the declared out.txt path instead of writing a file to it).
 * When invoked as `exec resume <id> <prompt>`, appends to the target file to
 * simulate native session continuation.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("codex-cli 9.9.9 (fake)");
  process.exit(0);
}

const isResume = args[0] === "exec" && args[1] === "resume";
const resumeId = isResume ? args[2] : null;
const prompt = args[args.length - 1] ?? "";

const dumpMatch = prompt.match(/DUMPENV:(\S+)/);
if (dumpMatch) writeFileSync(dumpMatch[1], JSON.stringify(process.env, null, 2));

const emit = (obj) => console.log(JSON.stringify(obj));
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
// Cleanly-parsed harness warning + todo noise (observed live) - must not
// poison parser health or block `verified`:
emit({ type: "item.completed", item: { id: "item_w", type: "error", message: "Model metadata for `fake/model` not found. Defaulting to fallback metadata" } });
emit({ type: "item.completed", item: { id: "item_t", type: "todo_list", items: [{ text: "step", completed: true }] } });

if (prompt.includes("MCPTOOLS")) {
  emit({
    type: "item.completed",
    item: { id: "item_m", type: "mcp_tool_call", server: "fake-server", tool_name: "fake_tool", arguments: { q: "x" }, output: "tool ok" },
  });
  emit({
    type: "item.completed",
    item: { id: "item_s", type: "web_search", query: "fake search query" },
  });
}

if (prompt.includes("FAIL")) {
  emit({ type: "turn.failed", error: "simulated failure" });
  process.exit(1);
}

if (prompt.includes("MKDIRARTIFACT")) mkdirSync("out.txt");
else if (isResume) appendFileSync("out.txt", "resumed OK\n");
else writeFileSync("out.txt", "deliverable content\n");

emit({
  type: "turn.completed",
  usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 80, reasoning_output_tokens: 10 },
});

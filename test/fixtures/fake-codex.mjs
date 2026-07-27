#!/usr/bin/env node
/**
 * Stub codex for the conformance suite. Emits the exec --json JSONL shape
 * captured VERBATIM from codex-cli 0.144.6 on 2026-07-22 (see the adapter's
 * doc comment). Prompt directives (env is stripped by design): FAIL, DUMPENV:<p>,
 * MCPTOOLS (emit an mcp_tool_call/web_search item pair in the REAL codex
 * ThreadItem shape - separate `server`/`tool` fields, `result` as a
 * structured McpToolCallResult object, not a string - real item types
 * confirmed against the installed @openai/codex 0.145.0 binary's item-type
 * enum, previously unmapped and parser-health-poisoning), MKDIRARTIFACT
 * (mkdir the declared out.txt path instead of writing a file to it),
 * TRAPSIGTERM (ignore `mc kill`'s SIGTERM, finish normally, exit 0 anyway -
 * classification must still land `killed`).
 * When invoked as `exec resume <id> <prompt>`, appends to the target file to
 * simulate native session continuation.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

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

if (prompt.includes("TRAPSIGTERM")) {
  // Simulates a harness that traps/ignores `mc kill`'s SIGTERM and finishes
  // "normally" anyway - the run must still be classified `killed`, because
  // the kill was requested regardless of what the child does afterward.
  let signaled = false;
  process.on("SIGTERM", () => {
    signaled = true;
  });
  while (!signaled) {
    await sleep(50);
  }
  writeFileSync("out.txt", "deliverable content\n");
  emit({
    type: "turn.completed",
    usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
  });
  process.exit(0);
}

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
  // REAL ThreadItem shape: `server` and `tool` are separate fields (the tool
  // NAME is `tool`, not `server`), and `result` is a structured
  // McpToolCallResult object, never a plain string.
  emit({
    type: "item.completed",
    item: {
      id: "item_m",
      type: "mcp_tool_call",
      server: "fake-server",
      tool: "fake_tool",
      arguments: { q: "x" },
      result: { content: [{ type: "text", text: "tool ok" }], isError: false },
    },
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

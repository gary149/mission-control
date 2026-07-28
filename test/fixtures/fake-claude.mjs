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
import { execSync } from "node:child_process";
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
// Subagent/background-task lifecycle - system SUBTYPES captured VERBATIM from
// claude-code 2.1.220 (live run 58f449 on the openclaw host, 2026-07-27). An
// earlier version of this fixture faked these as top-level types transcribed
// from an analysis report instead of a real stream, which let dead adapter
// cases pass green while real runs filed them as errors - keep these verbatim.
emit({ type: "system", subtype: "task_started", task_id: "bc8l380mx", tool_use_id: "Bash_22", description: "Probe candidate fire data and basemap endpoints", task_type: "local_bash", uuid: "de9cd286-48cf-4303-8742-4f704501d30a", session_id: "c28490ea-4f43-4c64-9333-799ead0e33b7" });
emit({ type: "system", subtype: "task_progress", task_id: "wtga1fo90", tool_use_id: "Workflow_24", description: "Research fire data sources, build 3D frontend and FastAPI backend in parallel", usage: { total_tokens: 0, tool_uses: 0, duration_ms: 76 }, summary: "Research fire data sources, build 3D frontend and FastAPI backend in parallel", workflow_progress: [{ type: "workflow_phase", index: 1, title: "Recherche" }, { type: "workflow_phase", index: 2, title: "Frontend" }, { type: "workflow_phase", index: 3, title: "Backend" }], uuid: "090859b5-3acc-44d8-8a64-c5c083e00001", session_id: "c28490ea-4f43-4c64-9333-799ead0e33b7" });
emit({ type: "system", subtype: "task_updated", task_id: "btfgjqgv2", patch: { status: "failed", end_time: 1785150239528 }, uuid: "b8757d4b-d042-4879-bd67-07990bfc0955", session_id: "c28490ea-4f43-4c64-9333-799ead0e33b7" });
emit({ type: "system", subtype: "task_notification", task_id: "bc8l380mx", tool_use_id: "Bash_22", status: "completed", output_file: "", summary: "Probe candidate fire data and basemap endpoints", uuid: "8066f7b8-7714-428d-9e69-acce8805377d", session_id: "c28490ea-4f43-4c64-9333-799ead0e33b7" });
emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "wtga1fo90", task_type: "local_workflow", description: "Research fire data sources, build 3D frontend and FastAPI backend in parallel" }], uuid: "71c1eba0-7ab4-487b-b33d-a617a8c53ce1", session_id: "c28490ea-4f43-4c64-9333-799ead0e33b7" });
// Tool-call heartbeat noise for long-running calls - a TOP-LEVEL type, not a
// system subtype, captured VERBATIM from a live run (claude-code 2.1.220,
// hermes host, 2026-07-28, run 1e0e37) - must not trip parser health.
emit({ type: "tool_progress", tool_use_id: "Bash_211-heartbeat-12", tool_name: "Bash", parent_tool_use_id: "Bash_211", elapsed_time_seconds: 390, heartbeat: true, session_id: "12c2a9e2-8e81-4035-85ed-4417275b07e0", uuid: "d6b76be3-876c-406f-bd87-7c5b02048b74" });
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

// GITCOMMIT: do the work and COMMIT it, leaving a clean tree - the shape the
// commit-aware git_effect check must reward.
if (prompt.includes("GITCOMMIT")) {
  writeFileSync("out.txt", "committed deliverable\n");
  execSync("git add -A && git -c user.email=fake@test -c user.name=fake commit -q -m 'fake work'", { stdio: "ignore" });
  emit({
    type: "result",
    subtype: "success",
    total_cost_usd: 0.1,
    usage: { input_tokens: 100, output_tokens: 25 },
    num_turns: 1,
    result: "Committed.",
    session_id: "fake-session-123",
  });
  process.exit(0);
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

export const EVENT_KINDS = [
    "started",
    "text",
    "tool_call",
    "tool_result",
    "subagent",
    "turn_end",
    "cost_update",
    "artifact",
    "status_change",
    "verify_result",
    "notify_result",
    "error",
    "exited",
];
/** Preflight failures are user errors: named, actionable, never a stack trace. */
export class PreflightError extends Error {
}

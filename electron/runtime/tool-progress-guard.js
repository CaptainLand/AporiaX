import { createHash } from "node:crypto";

const VOLATILE = new Set(["timestamp", "startedAt", "completedAt", "finishedAt", "duration", "durationMs", "elapsedMs", "callId", "requestId", "progressWarning", "resultRef"]);
const CONTROL_TOOLS = new Set(["collect_subagents", "delegate_subagent", "followup_subagent", "cancel_subagent", "finish_task", "update_plan", "complete_self_check", "request_self_check"]);
function stable(value, omitVolatile = false) {
  if (Array.isArray(value)) return value.map((item) => stable(item, omitVolatile));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => !omitVolatile || !VOLATILE.has(key)).map((key) => [key, stable(value[key], omitVolatile)]));
  return typeof value === "string" ? value.replace(/\r\n/g, "\n") : value;
}
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class ToolProgressGuard {
  #recent = [];
  #version = null;
  #budget;
  #exhausted = false;
  lastDecision = null;
  constructor({ maxRepeatedEvidence = 0 } = {}) {
    if (!Number.isSafeInteger(maxRepeatedEvidence) || maxRepeatedEvidence < 0 || maxRepeatedEvidence > 64)
      throw new TypeError("Invalid repeated-evidence budget.");
    this.#budget = maxRepeatedEvidence;
  }
  reset() { this.#recent = []; this.#version = null; this.#exhausted = false; this.lastDecision = null; }
  assertBudget() {
    if (this.#exhausted) throw Object.assign(new Error("LOOP_NO_PROGRESS: repeated evidence reached the caller's configured budget. Inspect preserved results or add new guidance before continuing."), { code: "LOOP_NO_PROGRESS" });
  }
  observe({ tool, input, result, version = "" }) {
    this.lastDecision = null;
    if (CONTROL_TOOLS.has(tool) || result?.skipped) return null;
    if (version !== this.#version) { this.reset(); this.#version = version; }
    const polling = tool === "read_process";
    // Invalid/synthetic polling records cannot establish a process progress key.
    if (polling && (!result?.processId || !Number.isFinite(result.cursor))) return null;
    const key = digest([tool, stable(input), stable(result, true)]);
    this.#recent.push(key);
    if (this.#recent.length > 64) this.#recent.shift();
    const count = this.#recent.filter((item) => item === key).length;
    // Waiting for a quiet but live process is not proof the task is stuck.
    // Advise a larger wait/cursor, but do not apply the hard evidence budget.
    const interval = polling ? 6 : 3;
    const budgetReached = !polling && this.#budget > 0 && count >= this.#budget;
    if (budgetReached) this.#exhausted = true;
    if (!budgetReached && (count < interval || count % interval !== 0)) return null;
    const action = budgetReached ? "budget" : polling ? "wait" : count >= 6 ? "replan" : "warn";
    this.lastDecision = { action, repeated: count, polling };
    return polling
      ? `Process ${result.processId} has unchanged output/cursor after ${count} reads. Wait for progress or inspect status before polling again; a quiet process is not automatically cancelled.`
      : `Repeated ${tool} returned unchanged evidence ${count} times. Change strategy, inspect a different source, or explain the blocker; ${budgetReached ? "the configured no-progress budget stops the next model round" : action === "replan" ? "replan using new evidence rather than repeating this action" : "this warning does not cancel the task"}.`;
  }
}

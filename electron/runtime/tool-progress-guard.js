import { createHash } from "node:crypto";

const VOLATILE = new Set(["timestamp", "startedAt", "completedAt", "finishedAt", "duration", "durationMs", "elapsedMs", "callId", "requestId", "progressWarning", "resultRef"]);
const CONTROL_TOOLS = new Set(["task_brief", "replan_strategy", "wait_process", "collect_subagents", "delegate_subagent", "followup_subagent", "cancel_subagent", "finish_task", "update_plan", "complete_self_check", "request_self_check"]);
function stable(value, omitVolatile = false) {
  if (Array.isArray(value)) return value.map((item) => stable(item, omitVolatile));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => !omitVolatile || !VOLATILE.has(key)).map((key) => [key, stable(value[key], omitVolatile)]));
  return typeof value === "string" ? value.replace(/\r\n/g, "\n") : value;
}
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class ToolProgressGuard {
  #recent = [];
  #repetitionEvidence = [];
  #version = null;
  #budget;
  #exhausted = false;
  #planning = 0;
  lastDecision = null;
  constructor({ maxRepeatedEvidence = 6, snapshot } = {}) {
    if (!Number.isSafeInteger(maxRepeatedEvidence) || maxRepeatedEvidence < 0 || maxRepeatedEvidence > 64)
      throw new TypeError("Invalid repeated-evidence budget.");
    this.#budget = maxRepeatedEvidence;
    if (snapshot?.version === 1) {
      this.#recent = (Array.isArray(snapshot.recent) ? snapshot.recent : []).filter(key => typeof key === "string" && /^[a-f0-9]{64}$/.test(key)).slice(-64);
      this.#repetitionEvidence = (Array.isArray(snapshot.repetitionEvidence) ? snapshot.repetitionEvidence : this.#recent).filter(key => typeof key === "string" && /^[a-f0-9]{64}$/.test(key)).slice(-64);
      this.#version = typeof snapshot.evidenceVersion === "string" ? snapshot.evidenceVersion : null;
      this.#planning = Number.isSafeInteger(snapshot.planning) ? Math.max(0, Math.min(64, snapshot.planning)) : 0;
      this.#exhausted = this.#budget > 0 && (this.#planning >= this.#budget || this.#repetitionEvidence.some(key => this.#repetitionEvidence.filter(item => item === key).length >= this.#budget));
    }
  }
  get blocked() { return this.#exhausted; }
  snapshot() { return { version: 1, recent: [...this.#recent], repetitionEvidence: [...this.#repetitionEvidence], evidenceVersion: this.#version, planning: this.#planning }; }
  reset() { this.#recent = []; this.#repetitionEvidence = []; this.#version = null; this.#planning = 0; this.#exhausted = false; this.lastDecision = null; }
  assertBudget() {
    if (this.#exhausted) throw Object.assign(new Error("LOOP_NO_PROGRESS: repeated evidence or planning without execution reached the no-progress budget. Progress is preserved; inspect results or add guidance before resuming."), { code: "LOOP_NO_PROGRESS" });
  }
  observe({ tool, input, result, version = "" }) {
    this.lastDecision = null;
    if (result?.skipped) return null;
    if (version !== this.#version) { this.reset(); this.#version = version; }
    if (["update_plan", "task_brief", "replan_strategy"].includes(tool)) {
      this.#planning += 1;
      const budgetReached = this.#budget > 0 && this.#planning >= this.#budget;
      if (budgetReached) this.#exhausted = true;
      if (!budgetReached && this.#planning % 3 !== 0) return null;
      this.lastDecision = { action: budgetReached ? "budget" : "warn", repeated: this.#planning, planning: true, polling: false };
      return `Planning was updated ${this.#planning} times without new execution evidence. Inspect a new source or perform the planned work; rewording a plan is not progress${budgetReached ? "; the next model round is paused until explicit user resume" : ""}.`;
    }
    if (CONTROL_TOOLS.has(tool)) return null;
    const polling = tool === "read_process";
    // Invalid/synthetic polling records cannot establish a process progress key.
    if (polling && (!result?.processId || !Number.isFinite(result.cursor))) return null;
    const key = digest([tool, stable(input), stable(result, true)]);
    if (polling || !this.#recent.includes(key)) {
      this.#planning = 0;
      this.#repetitionEvidence = [];
      this.#exhausted = false;
    }
    if (!polling) {
      this.#repetitionEvidence.push(key);
      if (this.#repetitionEvidence.length > 64) this.#repetitionEvidence.shift();
    }
    // Process polling has its own advisory policy and is never restored as
    // hard-budget evidence after restart.
    this.#recent.push(polling ? `poll:${key}` : key);
    if (this.#recent.length > 64) this.#recent.shift();
    const count = this.#recent.filter((item) => item === (polling ? `poll:${key}` : key)).length;
    // Waiting for a quiet but live process is not proof the task is stuck.
    // Advise a larger wait/cursor, but do not apply the hard evidence budget.
    const interval = polling ? 6 : 3;
    const unchangedCount = this.#repetitionEvidence.filter(item => item === key).length;
    const budgetReached = !polling && this.#budget > 0 && unchangedCount >= this.#budget;
    if (budgetReached) this.#exhausted = true;
    if (!budgetReached && (count < interval || count % interval !== 0)) return null;
    const action = budgetReached ? "budget" : polling ? "wait" : count >= 6 ? "replan" : "warn";
    this.lastDecision = { action, repeated: count, polling };
    return polling
      ? `Process ${result.processId} has unchanged output/cursor after ${count} reads. Wait for progress or inspect status before polling again; a quiet process is not automatically cancelled.`
      : `Repeated ${tool} returned unchanged evidence ${count} times. Change strategy, inspect a different source, or explain the blocker; ${budgetReached ? "the configured no-progress budget stops the next model round" : action === "replan" ? "replan using new evidence rather than repeating this action" : "this warning does not cancel the task"}.`;
  }
}

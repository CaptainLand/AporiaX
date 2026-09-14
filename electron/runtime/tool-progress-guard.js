import { createHash } from "node:crypto";

const VOLATILE = new Set(["timestamp", "startedAt", "completedAt", "duration", "durationMs", "elapsedMs", "callId", "requestId"]);
const CONTROL_TOOLS = new Set(["read_process", "collect_subagents", "delegate_subagent", "followup_subagent", "cancel_subagent", "finish_task", "update_plan", "complete_self_check", "request_self_check"]);
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter((key) => !VOLATILE.has(key)).map((key) => [key, stable(value[key])]));
  return typeof value === "string" ? value.replace(/\r\n/g, "\n") : value;
}
const digest = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

export class ToolProgressGuard {
  #recent = [];
  #version = null;
  reset() { this.#recent = []; this.#version = null; }
  observe({ tool, input, result, version = "" }) {
    if (CONTROL_TOOLS.has(tool) || result?.skipped) return null;
    if (version !== this.#version) { this.reset(); this.#version = version; }
    const key = digest([tool, input, result]);
    this.#recent.push(key);
    if (this.#recent.length > 64) this.#recent.shift();
    const count = this.#recent.filter((item) => item === key).length;
    return count >= 3 && count % 3 === 0
      ? `Repeated ${tool} returned unchanged evidence ${count} times. Change strategy, inspect a different source, or explain the blocker; this warning does not cancel the task.`
      : null;
  }
}

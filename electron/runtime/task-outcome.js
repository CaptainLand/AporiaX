const OUTCOMES = new Set(["completed", "partial", "blocked", "needs_input"]);

// Structured model intent, not a heuristic over prose. Never infer success
// from transport completion, a stopped worker, or an empty response.
export function readTaskOutcome(message, parseArguments) {
  const calls = message?.tool_calls || [];
  const finish = calls.find((call) => call.function?.name === "finish_task");
  if (!finish) return null;
  if (calls.length !== 1) throw new Error("FINISH_TASK_MUST_BE_ALONE: finish_task cannot be mixed with other operations.");
  const input = parseArguments(finish);
  if (!OUTCOMES.has(input.status) || typeof input.summary !== "string" || !input.summary.trim()) {
    throw new Error("INVALID_TASK_OUTCOME: status and a nonempty evidence-backed summary are required.");
  }
  return { status: input.status, summary: input.summary.trim() };
}

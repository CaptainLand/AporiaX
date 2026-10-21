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
  for (const [key, limit] of [['details', 24000], ['limitations', 4000], ['warnings', 4000]]) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > limit)) {
      throw new Error(`INVALID_TASK_OUTCOME: ${key} must be text within ${limit} characters.`);
    }
  }
  return { status: input.status, summary: input.summary.trim(),
    ...(input.details?.trim() ? { details: input.details.trim() } : {}),
    ...(input.limitations?.trim() ? { limitations: input.limitations.trim() } : {}),
    ...(input.warnings?.trim() ? { warnings: input.warnings.trim() } : {}) };
}

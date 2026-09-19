import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const READS = new Set(["read_file", "search_text", "list_directory", "git_status", "git_diff", "git_log", "inspect_office_file", "read_process", "wait_process", "mcp_read_result", "read_conversation_history"]);
const CONTROLS = new Set(["task_brief", "replan_strategy", "update_plan", "finish_task", "collect_subagents", "cancel_subagent"]);
const normalize = (value) => String(value || "").replace(/\r\n/g, "\n").replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|seconds)\b/gi, "[duration]").trim();

export const REPLAN_TOOL = { type: "function", function: {
  name: "replan_strategy",
  description: "After repeated identical failures or an edit oscillation, record a different concise hypothesis backed by NEW diagnostic tool calls. Unlocks one further repair attempt through normal permissions. Does not approve tools, change requirements or certify the hypothesis. Do not repeat the rejected approach or reveal private reasoning.",
  parameters: { type: "object", properties: {
    hypothesis: { type: "string", minLength: 20, maxLength: 1200 },
    evidence_call_ids: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
  }, required: ["hypothesis", "evidence_call_ids"], additionalProperties: false },
} };

/** Detect strategy failures across file versions. No claim of semantic
 * understanding: a replan must be different and cite newly observed evidence.
 */
export class StrategyHistory {
  #state;
  #fresh = new Map();
  #seen = new Set();
  #limit;
  constructor(saved = null, { maxInterventions = 2 } = {}) {
    this.#limit = maxInterventions;
    this.#state = { version: 1, failures: [], edits: [], plans: [], pending: null, exhausted: false };
    if (saved) {
      if (saved.version !== 1 || JSON.stringify(saved).length > 100_000 || !Array.isArray(saved.failures) || !Array.isArray(saved.edits) || !Array.isArray(saved.plans)) throw new Error("STRATEGY_SNAPSHOT_INVALID");
      this.#state = structuredClone(saved);
    }
  }
  reset() { this.#state = { version: 1, failures: [], edits: [], plans: [], pending: null, exhausted: false }; this.#fresh.clear(); this.#seen.clear(); }
  snapshot() { return structuredClone(this.#state); }
  briefing() {
    if (!this.#state.pending && !this.#state.plans.length && !this.#state.exhausted) return null;
    return { pending: this.#state.pending, exhausted: this.#state.exhausted, previousHypotheses: this.#state.plans.map((p) => p.hypothesis),
      freshDiagnosticCallIds: [...this.#fresh.keys()], note: "Repeated failing actions require new diagnostic evidence and replan_strategy. This does not relax permissions or acceptance criteria." };
  }
  assertBudget() { if (this.#state.exhausted) throw Object.assign(new Error("LOOP_STRATEGY_EXHAUSTED: repeated repair strategies failed; preserve work and request a new direction."), { code: "LOOP_STRATEGY_EXHAUSTED" }); }
  before(tool) {
    if (this.#state.pending && !READS.has(tool) && !CONTROLS.has(tool))
      throw new Error("STRATEGY_REPLAN_REQUIRED: stop repeating mutations/commands. Inspect NEW diagnostic evidence, then call replan_strategy with a different hypothesis. Existing permissions still apply.");
  }
  #request(reason, details) {
    if (this.#state.pending) return;
    this.#fresh.clear();
    this.#state.pending = { reason, ...details };
    if (this.#state.plans.length >= this.#limit) this.#state.exhausted = true;
  }
  observe({ callId, tool, input = {}, result = {}, changes = [] }) {
    if (result?.skipped || /STRATEGY_REPLAN_REQUIRED/.test(result?.error || "")) return;
    const failed = Boolean(result.error || result.timedOut || result.isError || (typeof result.exitCode === "number" && result.exitCode !== 0));
    if (READS.has(tool) && !failed && !["read_process", "wait_process"].includes(tool)) {
      const { resultRef, timestamp, startedAt, completedAt, durationMs, elapsedMs, progressWarning, ...meaningful } = result;
      const key = hash([tool, input, meaningful]);
      if (!this.#seen.has(key)) {
        this.#seen.add(key);
        if (this.#state.pending && callId) this.#fresh.set(callId, key);
      }
      while (this.#seen.size > 128) this.#seen.delete(this.#seen.values().next().value);
      while (this.#fresh.size > 32) this.#fresh.delete(this.#fresh.keys().next().value);
    }
    if (tool === "run_command") {
      const command = normalize(input.command), cwd = input.cwd || ".";
      if (!failed && result.exitCode === 0) {
        this.#state.failures = this.#state.failures.filter((item) => item.command !== command || item.cwd !== cwd);
      } else if (failed) {
        const diagnostic = normalize(result.error || `${result.stderr || ""}\n${result.stdout || ""}`).slice(0, 3000);
        const key = hash([command, cwd, diagnostic, result.exitCode ?? null]);
        this.#state.failures.push({ key, command, cwd, callId, diagnostic: diagnostic.slice(0, 500) });
        this.#state.failures = this.#state.failures.slice(-24);
        if (this.#state.failures.filter((item) => item.key === key).length >= 3)
          this.#request("Repeated command failed with unchanged diagnostics", { command, callIds: this.#state.failures.filter((item) => item.key === key).map((item) => item.callId) });
      }
    }
    for (const change of changes) {
      const digest = hash([Boolean(change.afterMissing), change.afterContent]);
      this.#state.edits.push({ path: change.path, digest, callId });
      this.#state.edits = this.#state.edits.slice(-48);
      const history = this.#state.edits.filter((item) => item.path === change.path).slice(-4);
      if (history.length === 4 && history[0].digest === history[2].digest && history[1].digest === history[3].digest && history[0].digest !== history[1].digest)
        this.#request("File oscillates between the same two versions", { path: change.path, callIds: history.map((item) => item.callId) });
    }
    return this.briefing();
  }
  replan(input) {
    this.assertBudget();
    if (!this.#state.pending) throw new Error("STRATEGY_NO_REPLAN_PENDING");
    const hypothesis = normalize(input.hypothesis);
    if (hypothesis.length < 20 || hypothesis.length > 1200 || this.#state.plans.some((item) => normalize(item.hypothesis).toLowerCase() === hypothesis.toLowerCase()))
      throw new Error("STRATEGY_NEW_HYPOTHESIS_REQUIRED");
    const ids = input.evidence_call_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 8 || ids.some((id) => !this.#fresh.has(id))) throw new Error("STRATEGY_FRESH_EVIDENCE_REQUIRED");
    this.#state.plans.push({ hypothesis, evidenceCallIds: [...new Set(ids)], priorFailure: this.#state.pending });
    this.#state.pending = null; this.#state.failures = []; this.#state.edits = []; this.#fresh.clear();
    return { accepted: true, hypothesis, evidenceCallIds: ids, remainingInterventions: this.#limit - this.#state.plans.length,
      note: "Hypothesis is an agent assertion, not verified. Test a different repair through existing tools and permissions." };
  }
}

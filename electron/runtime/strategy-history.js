import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const READS = new Set(["read_file", "search_text", "list_directory", "git_status", "git_diff", "git_log", "inspect_office_file", "read_process", "wait_process", "mcp_read_result", "read_conversation_history"]);
const COMMANDS = new Set(["run_command", "start_process"]);
const PROCESSES = new Set(["read_process", "wait_process", "start_process"]);
const CONTROLS = new Set(["task_brief", "replan_strategy", "update_plan", "finish_task", "collect_subagents", "cancel_subagent", "kill_process"]);
const normalize = (value) => String(value || "").replace(/\r\n/g, "\n").replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|seconds)\b/gi, "[duration]").trim();
const cwdOf = (value) => String(value || ".").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
const issueOf = (failure) => failure.issueKey || hash(failure.command
  ? ["command", failure.command, cwdOf(failure.cwd)]
  : ["file", failure.path]);
const emptyState = () => ({ version: 1, failures: [], edits: [], plans: [], pending: null, exhausted: false });

function diagnosticKey(tool, input, result, changes) {
  if (changes.length) return null;
  if (PROCESSES.has(tool)) {
    // Cursors, PIDs and wait duration are transport metadata, not new evidence.
    // A nonzero process exit can still explain the failure being investigated.
    const output = normalize(result.output);
    if (!output && !Number.isInteger(result.exitCode)) return null;
    return hash(["process", result.command || "", cwdOf(result.cwd), output, result.exitCode ?? null]);
  }
  if (tool === "run_command") {
    if (!Number.isInteger(result.exitCode)) return null; // denial/unknown outcome
    return hash(["command", normalize(input.command), cwdOf(input.cwd),
      normalize(result.stdout), normalize(result.stderr), normalize(result.error), result.exitCode]);
  }
  if (!READS.has(tool) || result.error || result.timedOut || result.isError) return null;
  const { resultRef, timestamp, startedAt, completedAt, durationMs, elapsedMs, progressWarning, ...meaningful } = result;
  return hash([tool, input, meaningful]);
}

export const REPLAN_TOOL = { type: "function", function: {
  name: "replan_strategy",
  description: "After repeated identical failures or an edit oscillation, record a different concise hypothesis backed by NEW diagnostic tool calls. Advisory mode recommends replanning; strict mode gates further mutation/repetition. Other diagnostic commands and process output remain available through normal permissions. Does not approve tools or certify the hypothesis. Do not reveal private reasoning.",
  parameters: { type: "object", properties: {
    hypothesis: { type: "string", minLength: 20, maxLength: 1200 },
    evidence_call_ids: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
  }, required: ["hypothesis", "evidence_call_ids"], additionalProperties: false },
} };

/** Progress policy, NOT a shell security boundary. Diagnostic commands still
 * pass the ordinary permission/scope/durable executor; we do not guess whether
 * arbitrary shell text is read-only or use this policy as permission to replay.
 */
export class StrategyHistory {
  #state;
  #fresh = new Map();
  #seen = new Set();
  #limit;
  #mode;
  constructor(saved = null, { maxInterventions = 2, mode = "advisory" } = {}) {
    if (!Number.isInteger(maxInterventions) || maxInterventions < 0 || maxInterventions > 4 ||
        !["advisory", "strict"].includes(mode)) throw new Error("STRATEGY_POLICY_INVALID");
    this.#limit = maxInterventions; this.#mode = mode;
    this.#state = emptyState();
    if (saved) {
      if (saved.version !== 1 || JSON.stringify(saved).length > 300_000 || !Array.isArray(saved.failures) || !Array.isArray(saved.edits) || !Array.isArray(saved.plans)) throw new Error("STRATEGY_SNAPSHOT_INVALID");
      this.#state = structuredClone(saved);
      this.#state.plans = this.#state.plans.slice(-24);
      this.#seen = new Set((saved.seenDiagnostics || []).filter((key) => typeof key === "string" && /^[a-f0-9]{64}$/.test(key)).slice(-128));
      delete this.#state.seenDiagnostics;
      // Old snapshots stored a global exhausted bit. Recompute per problem and
      // from the current user-selected policy, never revive that global stop.
      this.#refreshExhaustion();
    }
  }
  #attempts(issue) {
    return this.#state.plans.filter((plan) => !plan.resolved && issueOf(plan.priorFailure) === issue).length;
  }
  #refreshExhaustion() {
    this.#state.exhausted = Boolean(this.#limit > 0 && this.#state.pending &&
      this.#attempts(issueOf(this.#state.pending)) >= this.#limit);
  }
  reset() { this.#state = emptyState(); this.#fresh.clear(); this.#seen.clear(); }
  snapshot() { return { ...structuredClone(this.#state), seenDiagnostics: [...this.#seen] }; }
  briefing() {
    if (!this.#state.pending && !this.#state.plans.length && !this.#state.exhausted) return null;
    return { mode: this.#mode, blocking: this.#mode === "strict" && this.#limit > 0,
      pending: this.#state.pending, exhausted: this.#state.exhausted,
      previousHypotheses: this.#state.plans.map((p) => p.hypothesis),
      freshDiagnosticCallIds: [...this.#fresh.keys()],
      note: this.#mode === "strict" && this.#limit > 0
        ? "For this problem, inspect fresh diagnostics and replan before more mutation or the same failing command. Different commands and process reads remain available through existing permissions."
        : "Advisory only: consider fresh diagnostics and a different strategy. This warning never stops the task or grants permissions." };
  }
  assertBudget() {
    if (this.#mode === "strict" && this.#limit > 0 && this.#state.exhausted)
      throw Object.assign(new Error("LOOP_STRATEGY_EXHAUSTED: repair strategies for this same problem failed; preserve work and request a new direction."), { code: "LOOP_STRATEGY_EXHAUSTED" });
  }
  before(tool, input = {}) {
    if (this.#mode !== "strict" || this.#limit === 0 || !this.#state.pending || READS.has(tool) || CONTROLS.has(tool)) return;
    const pending = this.#state.pending;
    if (COMMANDS.has(tool) && (!pending.command || normalize(input.command) !== pending.command || cwdOf(input.cwd) !== cwdOf(pending.cwd))) return;
    throw new Error("STRATEGY_REPLAN_REQUIRED: inspect fresh diagnostics and call replan_strategy before more mutation or repeating this command. Other commands/process reads remain available through normal permissions.");
  }
  #request(reason, details) {
    if (this.#state.pending) return;
    this.#fresh.clear();
    this.#state.pending = { reason, ...details };
    this.#refreshExhaustion();
  }
  observe({ callId, tool, input = {}, result = {}, changes = [] }) {
    if (result?.skipped || /STRATEGY_REPLAN_REQUIRED/.test(result?.error || "")) return;
    const failed = Boolean(result.error || result.timedOut || result.isError || (typeof result.exitCode === "number" && result.exitCode !== 0));
    const key = diagnosticKey(tool, input, result, changes);
    if (key && !this.#seen.has(key)) {
      this.#seen.add(key);
      if (this.#state.pending && callId) this.#fresh.set(callId, key);
      while (this.#seen.size > 128) this.#seen.delete(this.#seen.values().next().value);
      while (this.#fresh.size > 32) this.#fresh.delete(this.#fresh.keys().next().value);
    }
    if (tool === "run_command") {
      const command = normalize(input.command), cwd = cwdOf(input.cwd);
      if (!failed && result.exitCode === 0) {
        this.#state.failures = this.#state.failures.filter((item) => item.command !== command || cwdOf(item.cwd) !== cwd);
        for (const plan of this.#state.plans) if (plan.priorFailure.command === command && cwdOf(plan.priorFailure.cwd) === cwd) plan.resolved = true;
        if (this.#state.pending?.command === command && cwdOf(this.#state.pending.cwd) === cwd) {
          this.#state.pending = null; this.#fresh.clear();
        }
        this.#refreshExhaustion();
      } else if (failed) {
        // Do not let a generic executor error hide a changed stderr diagnosis.
        const diagnostic = normalize([result.error, result.stderr, result.stdout].filter(Boolean).join("\n")).slice(0, 3000);
        const key = hash(["command", command, cwd, diagnostic, result.exitCode ?? null]);
        this.#state.failures.push({ key, command, cwd, callId, diagnostic: diagnostic.slice(0, 500) });
        this.#state.failures = this.#state.failures.slice(-24);
        if (this.#state.failures.filter((item) => item.key === key).length >= 3)
          this.#request("Repeated command failed with unchanged diagnostics", { issueKey: key, command, cwd, callIds: this.#state.failures.filter((item) => item.key === key).map((item) => item.callId) });
      }
    }
    for (const change of changes) {
      const digest = hash([Boolean(change.afterMissing), change.afterContent]);
      this.#state.edits.push({ path: change.path, digest, callId });
      this.#state.edits = this.#state.edits.slice(-48);
      const history = this.#state.edits.filter((item) => item.path === change.path).slice(-4);
      if (history.length === 4 && history[0].digest === history[2].digest && history[1].digest === history[3].digest && history[0].digest !== history[1].digest)
        this.#request("File oscillates between the same two versions", { issueKey: hash(["file", change.path]), path: change.path, callIds: history.map((item) => item.callId) });
    }
    return this.briefing();
  }
  replan(input) {
    this.assertBudget();
    if (!this.#state.pending) throw new Error("STRATEGY_NO_REPLAN_PENDING");
    const issue = issueOf(this.#state.pending), hypothesis = normalize(input.hypothesis);
    if (hypothesis.length < 20 || hypothesis.length > 1200 || this.#state.plans.some((item) => !item.resolved && issueOf(item.priorFailure) === issue && normalize(item.hypothesis).toLowerCase() === hypothesis.toLowerCase()))
      throw new Error("STRATEGY_NEW_HYPOTHESIS_REQUIRED");
    const ids = input.evidence_call_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 8 || ids.some((id) => !this.#fresh.has(id))) throw new Error("STRATEGY_FRESH_EVIDENCE_REQUIRED");
    this.#state.plans.push({ hypothesis, evidenceCallIds: [...new Set(ids)], priorFailure: this.#state.pending });
    this.#state.plans = this.#state.plans.slice(-24);
    const remaining = Math.max(0, this.#limit - this.#attempts(issue));
    this.#state.pending = null; this.#state.failures = []; this.#state.edits = []; this.#fresh.clear(); this.#refreshExhaustion();
    return { accepted: true, hypothesis, evidenceCallIds: ids, remainingInterventions: remaining,
      note: "Hypothesis is an agent assertion, not verified. Test a different repair through existing tools and permissions. Budget applies to this problem, not unrelated work." };
  }
}

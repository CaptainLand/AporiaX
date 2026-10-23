import { createHash } from 'node:crypto';

const VOLATILE = new Set(['timestamp', 'startedAt', 'completedAt', 'finishedAt', 'duration', 'durationMs', 'elapsedMs', 'callId', 'requestId', 'progressWarning', 'resultRef']);
const CONTROLS = new Set(['wait_process', 'collect_subagents', 'delegate_subagent', 'followup_subagent', 'cancel_subagent', 'finish_task', 'complete_self_check', 'request_self_check']);
function stable(value, omit = false) {
  if (Array.isArray(value)) return value.map(item => stable(item, omit));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => !omit || !VOLATILE.has(key)).map(key => [key, stable(value[key], omit)]));
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value;
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exempt = (tool, input) => CONTROLS.has(tool) || tool === 'read_process' || tool === 'task_brief' && (!input?.action || input.action === 'read');

// A repeated action is not evidence that the entire task (or its siblings) is stuck.
export class ToolProgressGuard {
  #recent = [];
  #suppressed = new Set();
  #version = null;
  #budget;
  #polls = [];
  #suppressedAt = new Map();
  #now;
  lastDecision = null;
  constructor({ maxRepeatedEvidence = 6, snapshot, now = Date.now } = {}) {
    this.#now = now;
    if (!Number.isSafeInteger(maxRepeatedEvidence) || maxRepeatedEvidence < 0 || maxRepeatedEvidence > 64) throw new TypeError('Invalid repeated-evidence budget.');
    this.#budget = maxRepeatedEvidence;
    if (snapshot?.version === 2) {
      this.#recent = (snapshot.recent || []).filter(item => item && /^[a-f0-9]{64}$/.test(item.action) && /^[a-f0-9]{64}$/.test(item.evidence)).slice(-64);
      this.#suppressed = new Set((snapshot.suppressed || []).filter(key => /^[a-f0-9]{64}$/.test(key)));
      this.#suppressedAt = new Map((snapshot.suppressedAt || []).filter(([key, time]) => this.#suppressed.has(key) && Number.isFinite(time)));
      for (const key of this.#suppressed) if (!this.#suppressedAt.has(key)) this.#suppressedAt.set(key, this.#now());
      this.#version = snapshot.evidenceVersion;
    }
    // Version 1 global exhaustion is deliberately not migrated into a stop gate.
  }
  get blocked() { return false; }
  assertBudget() {} // Compatibility: there is no whole-task progress budget.
  snapshot() { return { version: 2, recent: [...this.#recent], suppressed: [...this.#suppressed], suppressedAt: [...this.#suppressedAt], evidenceVersion: this.#version }; }
  reset() { this.#recent = []; this.#polls = []; this.#suppressed.clear(); this.#suppressedAt.clear(); this.#version = null; this.lastDecision = null; }
  before(tool, input, version = '') {
    if (version !== this.#version || exempt(tool, input)) return;
    const action = digest([tool, stable(input)]);
    // A quiet external producer may have changed a file without a tool receipt.
    // Allow an occasional probe; never turn local suppression into a permanent lock.
    if (this.#suppressed.has(action) && this.#now() - this.#suppressedAt.get(action) >= 30_000) {
      this.#suppressed.delete(action); this.#suppressedAt.delete(action);
      this.#recent = this.#recent.filter(item => item.action !== action);
    }
    if (this.#suppressed.has(action)) throw Object.assign(new Error(
      `TOOL_REPEAT_SUPPRESSED: ${tool} repeatedly returned unchanged evidence. Only this exact action is suppressed until new evidence or workspace changes. Use a different query/source/tool, inspect existing results, or explain the blocker; other work and teammates remain available.`),
    { code: 'TOOL_REPEAT_SUPPRESSED' });
  }
  observe({ tool, input, result, version = '' }) {
    this.lastDecision = null;
    if (tool === 'read_process' && result?.processId && Number.isFinite(result.cursor)) {
      const key = digest([tool, stable(input), stable(result, true)]);
      this.#polls.push(key); this.#polls = this.#polls.slice(-64);
      const count = this.#polls.filter(item => item === key).length;
      if (count % 6) return null;
      this.lastDecision = { action: 'wait', polling: true, repeated: count, toolsClosed: false };
      return `Process output is unchanged after ${count} reads. Prefer wait_process; a quiet process is not automatically cancelled.`;
    }
    if (result?.skipped || result?.error?.startsWith?.('TOOL_REPEAT_SUPPRESSED') || exempt(tool, input)) return null;
    if (version !== this.#version) { this.reset(); this.#version = version; }
    const action = digest([tool, stable(input)]), evidence = digest(stable(result, true));
    const previous = this.#recent.findLast(item => item.action === action);
    // Switching A -> B is not progress on A. Only changed evidence for the
    // same action (or an explicit workspace/guidance version) resets it.
    if (previous && previous.evidence !== evidence) {
      this.#recent = this.#recent.filter(item => item.action !== action);
      this.#suppressed.delete(action);
      this.#suppressedAt.delete(action);
    }
    this.#recent.push({ action, evidence });
    this.#recent = this.#recent.slice(-64);
    const count = this.#recent.filter(item => item.action === action && item.evidence === evidence).length;
    const suppress = this.#budget > 0 && count >= this.#budget;
    if (suppress) { this.#suppressed.add(action); this.#suppressedAt.set(action, this.#now()); }
    if (!suppress && count % 3 !== 0) return null;
    this.lastDecision = { action: suppress ? 'suppress-action' : 'warn', repeated: count, tool, toolsClosed: false };
    return `Repeated ${tool} returned unchanged evidence ${count} times. ${suppress ? 'This exact action is temporarily suppressed' : 'Change the query or inspect a new source'}; other tools and independent teammates continue normally.`;
  }
}

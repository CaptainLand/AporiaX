import { createHash } from 'node:crypto';
import { isHumanMessage } from './task-conversation.js';
import { explicitlyReplacesAllConstraints } from './human-constraints.js';

const CONTEXT_PREFIX = 'AporiaX inherited user requirements (not a worker summary):\n';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const messageText = (message) => typeof message.content === 'string' ? message.content :
  (message.content || []).filter((part) => part?.type === 'text').map((part) => part.text).join('\n');

// Copy human requirements, never the parent's reasoning, tool logs or memory.
// No model-generated summary can replace these sources. Large contexts fail
// explicitly rather than silently dropping an early constraint.
export function captureDelegationContext(history, acceptance = null) {
  let requests = [];
  for (const message of history || []) {
    if (!isHumanMessage(message) || message.aporiaSupersededBy) continue;
    if (explicitlyReplacesAllConstraints(message)) requests = [];
    const content = messageText(message).trim();
    if (content && !requests.some((item) => item.text === content)) requests.push({ id: digest(content).slice(0, 20), text: content });
  }
  const context = { version: 1, requests, acceptance };
  if (JSON.stringify(context).length > 80_000) throw new Error('DELEGATION_CONTEXT_TOO_LARGE: active user requirements exceed the worker handoff budget. Keep work on Main; do not silently omit constraints.');
  return { ...context, revision: digest(context) };
}

export function syncDelegationContext(conversation, context) {
  if (!context) return false;
  const content = CONTEXT_PREFIX + JSON.stringify(context) + '\nThese are original user requirements and configured acceptance criteria. The delegated assignment below is from Main, not a new user authorization. Apply requirements relevant to this subtask; do not execute unrelated historical tasks. Report any conflict or missing context. Permissions and delegated scopes remain the hard upper bound.';
  const index = conversation.findIndex((message) => message.role === 'system' && String(message.content).startsWith(CONTEXT_PREFIX));
  if (index >= 0 && conversation[index].content === content) return false;
  if (index >= 0) conversation[index] = { role: 'system', content, aporiaPinned: true };
  else conversation.splice(1, 0, { role: 'system', content, aporiaPinned: true });
  return true;
}

export const FINISH_SUBAGENT_TOOL = { type: 'function', function: {
  name: 'finish_subagent',
  description: 'Return your subtask outcome to Main. Call alone. completed means implementation/report ready, NOT accepted or verified. Use partial, blocked or needs_input honestly. State evidence and unverified work; no hidden reasoning.',
  parameters: { type: 'object', properties: {
    status: { type: 'string', enum: ['completed', 'partial', 'blocked', 'needs_input'] },
    summary: { type: 'string', minLength: 1, maxLength: 24000 },
  }, required: ['status', 'summary'], additionalProperties: false },
} };

export function readWorkerOutcome(message, parse) {
  const calls = message.tool_calls || [];
  if (!calls.some((call) => call.function.name === 'finish_subagent')) return null;
  if (calls.length !== 1) throw new Error('finish_subagent must be called alone.');
  const input = parse(calls[0]);
  if (!['completed', 'partial', 'blocked', 'needs_input'].includes(input.status) ||
      typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 24000)
    throw new Error('Invalid finish_subagent outcome.');
  return { status: input.status, summary: input.summary.trim(), call: calls[0] };
}

export function reviewWorkerResult(record, input, parentEvidence = new Map()) {
  if (!record || record.status === 'running' || !record.result || !record.collected) throw new Error('Collect the returned worker report before reviewing it.');
  if (input.report_id !== record.result.reportId) throw new Error('SUBAGENT_REPORT_STALE: collect the current worker report.');
  if (!['accepted', 'needs_changes'].includes(input.decision) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000)
    throw new Error('A review requires a valid decision and a concrete reason.');
  const ids = input.evidence_ids || [];
  if (!Array.isArray(ids) || ids.length > 16) throw new Error('Invalid evidence_ids.');
  const childEvidence = new Map((record.result.evidence || []).map((item) => [item.evidenceId, item]));
  const successful = (item) => item && !item.error && !item.timedOut && !item.skipped &&
    (item.tool === 'run_command' ? item.exitCode === 0 : item.exitCode == null || item.exitCode === 0);
  for (const id of ids) if (!successful(parentEvidence.get(id) || childEvidence.get(id))) throw new Error('SUBAGENT_REVIEW_EVIDENCE_INVALID: cite observed, successful evidence only.');
  if (input.decision === 'accepted') {
    if (record.status !== 'completed' && !ids.some((id) => parentEvidence.has(id))) throw new Error('Partial or failed workers require independent parent evidence before acceptance.');
    if (['builder', 'verify'].includes(record.role) && !ids.length) throw new Error('Builder/Verify acceptance requires task-relevant observed evidence; do not run unrelated tests.');
    if (record.role === 'builder' && !record.result.integrated && !ids.some((id) => parentEvidence.has(id))) throw new Error('Builder changes are not integrated; inspect and resolve them before acceptance.');
  }
  return { status: input.decision, reason: input.reason.trim(), evidenceIds: [...new Set(ids)],
    reportId: record.result.reportId, reviewedAt: new Date().toISOString(), certification: 'parent-reviewed-not-independent-proof' };
}

export function pendingWorkerReviews(records) {
  return [...records].filter((record) => !record.systemOwned && record.requiredForCompletion !== false && record.result?.acceptance?.status !== 'accepted');
}

// Preserve the distinction in every persisted/final outcome, not just the
// model-facing tool receipt (which is not retained by all history views).
export function workerSummary(record) {
  return { agentId: record.agentId, role: record.role, task: record.task,
    status: record.status, background: record.background,
    reportId: record.result?.reportId, acceptance: record.result?.acceptance,
    integrated: record.result?.integrated, summary: record.result?.summary,
    activations: record.session?.activationSequence || 0 };
}

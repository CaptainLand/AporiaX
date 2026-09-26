import { getRouteToolMeta } from '../p0-model.js';
import { taskSuspensionLabel } from '../state/task-suspension.js';

const ACTIVE = new Set(['running', 'waiting']);
const FINAL = new Set(['completed', 'failed', 'interrupted', 'partial', 'blocked', 'needs_input']);
const text = (language, zh, en) => language === 'en' ? en : zh;

export function activityActor(record, language = 'zh-CN') {
  if (record.actor === 'witness') return 'Witness';
  if (record.actor !== 'subagent' && !record.agentId) return text(language, '主 Agent', 'Main agent');
  const roles = { builder: ['构建 Agent', 'Builder agent'], explore: ['探索 Agent', 'Explore agent'], review: ['审查 Agent', 'Review agent'], verify: ['验证 Agent', 'Verify agent'], curator: ['知识整理 Agent', 'Curator agent'] };
  const role = roles[record.role];
  return role ? text(language, ...role) : record.role ? `${record.role} Agent` : text(language, '子 Agent', 'Subagent');
}

export function activityStatus(status, language = 'zh-CN') {
  const labels = {
    running: ['执行中', 'Running'], waiting: ['等待确认', 'Awaiting approval'], paused: ['已暂停', 'Paused'],
    completed: ['已完成', 'Completed'], failed: ['失败', 'Failed'], interrupted: ['已停止', 'Stopped'],
    retry: ['重试中', 'Retrying'], recovered: ['后续已恢复', 'Later recovered'], skipped: ['已跳过', 'Skipped'],
    partial: ['部分完成', 'Partially complete'], blocked: ['受阻', 'Blocked'], needs_input: ['等待补充信息', 'Input needed'],
    starting: ['正在准备', 'Starting'], unknown: ['状态未知', 'Unknown status'],
  };
  return text(language, ...(labels[status] || labels.unknown));
}

export function routeRunStatus(run) {
  // The persisted final outcome wins over an old heartbeat. A newer terminal
  // heartbeat may precede the message outcome by one renderer event.
  if (run?.status && run.status !== 'running') return run.status;
  return run?.witness?.status || run?.status || 'starting';
}

export const ACTIVITY_AGENT_ROLES = ['main', 'explore', 'review', 'verify', 'curator', 'builder'];
export function routeAgentActivity(run) {
  const stored = run?.witness?.agentActivity;
  const terminal = FINAL.has(routeRunStatus(run));
  if (stored?.version === 1) return { ...stored,
    roles: Object.fromEntries(ACTIVITY_AGENT_ROLES.map((role) => [role, { ...stored.roles?.[role], active: terminal ? 0 : stored.roles?.[role]?.active || 0 }])),
    builder: { ...stored.builder, running: terminal ? 0 : stored.builder?.running || 0, queued: terminal ? 0 : stored.builder?.queued || 0 }, legacy: false };
  // Old tasks did not save lifetime counters. Show observed lower bounds rather
  // than inventing exact zeros or applying today's Builder setting to history.
  const workers = new Map((run?.witness?.agents || []).map((agent) => [agent.agentId, agent]));
  for (const record of run?.witness?.records || []) if (record.agentId && !workers.has(record.agentId)) workers.set(record.agentId, record);
  const roles = Object.fromEntries(ACTIVITY_AGENT_ROLES.map((role) => [role, { activations: role === 'main' ? null : [...workers.values()].filter((agent) => agent.role === role).length || null, active: 0 }]));
  return { roles, builder: { running: 0, queued: 0, peak: null, limit: null }, legacy: true };
}

export function activityRecordStatus(record, language = 'zh-CN') {
  if (record?.kind === 'queue' && record.status === 'waiting') return text(language, '排队中', 'Queued');
  if (record?.kind === 'agent' && record.status === 'completed') {
    const labels = { pending: ['待验收', 'Awaiting review'], accepted: ['已接受', 'Accepted'], needs_changes: ['需返工', 'Changes needed'], consumer_review: ['已返回', 'Returned'] };
    return text(language, ...(labels[record.acceptance?.status] || ['已返回', 'Returned']));
  }
  return activityStatus(record?.status, language);
}

export function routeRunLabel(run, language = 'zh-CN') {
  const status = routeRunStatus(run);
  if (status === 'paused') return taskSuspensionLabel(run?.witness?.pauseReasons, language);
  if (status === 'completed') {
    const delivery = run?.selfCheck?.delivery?.status;
    if (delivery === 'unverified' || run?.selfCheck?.verification?.waived) return text(language, '已交付 · 未验证', 'Delivered · Unverified');
    if (delivery === 'unavailable') return text(language, '已交付 · 验证不可用', 'Delivered · Verification unavailable');
    if (delivery === 'failed') return text(language, '已交付 · 验证未通过', 'Delivered · Checks failed');
  }
  return activityStatus(status, language);
}

function callKey(record) {
  if (!record.callId) return null;
  const agent = record.agentId || '';
  const call = agent && record.callId.startsWith(`${agent}:`) ? record.callId.slice(agent.length + 1) : record.callId;
  return `${agent}\0${call}`;
}

export function routeActivityRecords(run) {
  if (!run) return [];
  const witness = Array.isArray(run.witness?.records) ? run.witness.records : [];
  // With Witness present, never mix in synthetic legacy delivery/change steps:
  // those are a compatibility summary, not events that actually happened.
  const entries = witness.length ? run.rawEntries || [] : run.rawEntries?.length ? run.rawEntries : run.entries || [];
  const byCall = new Map(entries.map((entry) => [callKey(entry), entry]).filter(([key]) => key));
  const seen = new Set();
  const ids = new Set();
  const records = witness.map((record) => {
    const key = callKey(record), entry = key ? byCall.get(key) : null;
    if (key) seen.add(key);
    return { ...entry, ...record, error: record.error || entry?.error || '', exitCode: record.exitCode ?? entry?.exitCode ?? null };
  });
  // Legacy tools can arrive just before their heartbeat. Retain older entries
  // outside the bounded Witness window without duplicating matched calls.
  for (const entry of entries) {
    const key = callKey(entry);
    if (key ? seen.has(key) : witness.some((record) => record.id === entry.id)) continue;
    records.push({ ...entry, kind: entry.tool ? 'tool' : 'status', eventType: 'legacy.route', actor: entry.agentId ? 'subagent' : 'main' });
  }
  const state = routeRunStatus(run);
  return records.map((record, index) => {
    const completedAt = record.completedAt || record.finishedAt || null;
    const active = ACTIVE.has(record.status);
    const missingToolResult = record.kind === 'tool' && record.status === 'completed' && /tool\.started$/.test(record.eventType || '');
    const status = missingToolResult ? 'unknown' : active && FINAL.has(state) ? (state === 'completed' ? 'unknown' : state) : active && state === 'paused' ? 'paused' : record.status || 'unknown';
    return { ...record, id: record.id || `activity-${index}`, status, completedAt, elapsedMs: record.elapsedMs ?? (completedAt && record.startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(record.startedAt)) : 0), _order: index };
  }).filter((record) => {
    if (ids.has(record.id)) return false;
    ids.add(record.id); return true;
  }).sort((a, b) => {
    const timeA = Date.parse(a.startedAt), timeB = Date.parse(b.startedAt);
    return Number.isFinite(timeA) && Number.isFinite(timeB) ? timeA - timeB || a._order - b._order : a._order - b._order;
  });
}

export function activeRouteRecords(records) {
  const active = records.filter((record) => ACTIVE.has(record.status) || record.status === 'paused');
  // An agent's lifetime is a container, not a second action alongside its tool.
  return active.filter((record) => record.kind !== 'agent' || !active.some((other) => ['tool', 'queue'].includes(other.kind) && other.agentId === record.agentId));
}

export function describeRouteRecord(record, language = 'zh-CN') {
  const t = (zh, en) => text(language, zh, en);
  if (!record) return { title: t('等待执行记录', 'Waiting for activity'), detail: '' };
  if (record.kind === 'queue') return { title: record.status === 'waiting' ? t('等待 Cloud 模型槽位', 'Waiting for a Cloud model slot') : t('Cloud 排队记录', 'Cloud queue'), detail: record.detail || '' };
  if (record.kind === 'tool' || record.tool) {
    const meta = getRouteToolMeta(record.tool, record.phase, language, record.capability);
    const title = record.tool === 'run_command' && !record.capability ? t('运行命令', 'Run command') : meta.title;
    return { title, detail: record.error || record.command || record.path || record.detail || '' };
  }
  if (record.kind === 'thinking') return { title: ACTIVE.has(record.status) ? t('等待模型响应', 'Waiting for model response') : t('模型响应阶段', 'Model response phase'), detail: t('仅显示响应活动，不推测模型的内部思考。', 'Only response activity is shown; internal reasoning is not inferred.') };
  const titles = {
    'clarification.required': ['等待你的回答', 'Waiting for your answer'], 'clarification.updated': ['提问状态已更新', 'Question updated'],
    'turn.started': ['任务开始', 'Run started'], 'turn.completed': [activityStatus(record.status, 'zh-CN'), activityStatus(record.status, 'en')],
    'turn.failed': ['任务运行失败', 'Run failed'], 'turn.cancelled': ['任务已停止', 'Run stopped'],
    'response.retry': ['模型请求重试', 'Model request retry'],
    'response.quota.low.daily': ['全站额度 ≤5% · 正在收尾', 'Shared daily allowance ≤5% · Winding down'],
    'response.quota.low.weekly': ['周额度 ≤5% · 正在收尾', 'Weekly allowance ≤5% · Winding down'],
    'plan.updated': ['计划已更新', 'Plan updated'], 'parallel_batch.started': ['并行动作已开始', 'Parallel actions started'],
    'subagent.started': ['执行子任务', 'Working on subtask'], 'subagent.completed': ['子任务已返回', 'Subtask returned'], 'subagent.failed': ['子任务失败', 'Subtask failed'],
    'subagent.cancelled': ['子任务已停止', 'Subtask stopped'], 'subagent.reviewed': ['子任务验收记录', 'Subtask acceptance review'],
    'approval.required': ['等待用户确认', 'Awaiting user approval'], 'control.paused': ['任务已暂停', 'Run paused'], 'control.resumed': ['任务已继续', 'Run resumed'],
    'self_check.started': ['检查修改与验证结果', 'Review changes and verification'], 'self_check.completed': ['检查结果已记录', 'Review recorded'],
    'self_check.segment.started': ['分段检查', 'Staged review'], 'self_check.segment.completed': ['分段检查已返回', 'Staged review returned'],
    'self_check.fallback': ['调整检查方式', 'Review strategy changed'], 'self_check.sealed': ['当前版本检查依据已记录', 'Current-version review evidence recorded'],
    'instructions.loaded': ['目录规则已加载', 'Project rules loaded'], 'context.compacted': ['上下文已整理', 'Context compacted'], 'memory.updated': ['项目知识已更新', 'Project knowledge updated'],
  };
  const pair = titles[record.eventType];
  return { title: pair ? t(...pair) : record.title || (record.kind === 'warning' ? t('需要关注', 'Needs attention') : t('状态更新', 'Status update')), detail: record.error || record.detail || record.command || '' };
}

export function activityElapsed(record, now = Date.now()) {
  const start = Date.parse(record.startedAt);
  return ACTIVE.has(record.status) && Number.isFinite(start) ? Math.max(0, now - start) : Math.max(0, Number(record.elapsedMs) || 0);
}

export function formatActivityElapsed(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 1) return `${Math.round(milliseconds)}ms`;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

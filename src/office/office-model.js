import { effectiveRoleSettings } from '../../shared/professional-roles.js';
import { agentDescription, agentDisplayName, agentName } from '../../shared/agent-identity.js';
import { taskSuspensionLabel } from '../state/task-suspension.js';

const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'partial', 'blocked', 'needs_input', 'budget_exhausted']);
const LIVE = new Set(['running', 'starting', 'waiting', 'queued']);
const skins = {
  main: ['#458dd5', 'tie'], builder: ['#dd9964', 'headphones'], explore: ['#84a98a', 'antenna'],
  review: ['#d9867a', 'glasses'], verify: ['#c3ae69', 'cap'], curator: ['#849fae', 'antenna'],
};
const text = (language, zh, en) => language === 'en' ? en : zh;
const activeRecords = records => records.filter(record => ['running', 'waiting'].includes(record.status));

export function latestOfficeRun(task) {
  return [...(task?.messages || [])].reverse().find(message => message.role === 'assistant' && !message.isSteeringSegment && !message.supersededByRetryId) || null;
}

export function officeRoleName(role, language = 'zh-CN') {
  const names = { main: ['主管', 'Supervisor'], builder: ['开发', 'Builder'], explore: ['探索', 'Explorer'], review: ['审查', 'Reviewer'], verify: ['验证', 'Verifier'], curator: ['知识整理', 'Curator'] };
  return names[role] ? text(language, ...names[role]) : role || text(language, '专业角色', 'Specialist');
}

export function officeStatus(raw, language = 'zh-CN') {
  const pairs = {
    completed: ['已完成', 'Completed'], failed: ['执行失败', 'Failed'], interrupted: ['已停止', 'Stopped'], cancelled: ['已取消', 'Cancelled'],
    partial: ['部分完成', 'Partial'], blocked: ['执行受阻', 'Blocked'], needs_input: ['需要补充信息', 'Input needed'], budget_exhausted: ['预算已用尽', 'Budget exhausted'],
    idle: ['休息中', 'Idle'], unknown: ['状态未确认', 'Unconfirmed'], paused: ['已暂停', 'Paused'],
  };
  return pairs[raw] ? text(language, ...pairs[raw]) : String(raw || '—');
}

function terminalState(raw) {
  return raw === 'failed' ? 'error' : ['partial', 'blocked', 'needs_input', 'budget_exhausted'].includes(raw) ? 'attention' : 'sleeping';
}

export function buildOfficeModel({ task, isRunning = false, isPaused = false, approval, settings, snapshot, language = 'zh-CN' }) {
  const t = (zh, en) => text(language, zh, en);
  const run = latestOfficeRun(task);
  const runId = run?.runId || null;
  const witness = run?.witness;
  const rawStatus = TERMINAL.has(run?.status) ? run.status : TERMINAL.has(witness?.status) ? witness.status : run?.status || 'idle';
  const live = Boolean(run && isRunning && !TERMINAL.has(rawStatus) && !run.anchorRestoredAt);
  const paused = live && (isPaused || witness?.status === 'paused');
  // Only records from this assistant/run are consulted. Historical agents never
  // leak into a fresh run, and persisted running records do not imply a live task.
  const records = witness?.records || run?.route || [];
  const current = activeRecords(records);
  let profiles = [];
  if (settings) {
    const overrides = { ...task?.professionalRoles, ...(task?.builderLimit != null && task?.professionalRoles?.builderLimit == null ? { builderLimit: task.builderLimit } : {}) };
    profiles = effectiveRoleSettings(settings, overrides).profiles.filter(profile => profile.enabled);
  }
  const main = {
    id: 'lead', name: agentName('main', language), role: 'main', roleName: officeRoleName('main', language),
    color: skins.main[0], accessory: skins.main[1], agentId: null, runId,
    description: t('理解需求、分派工作并汇总团队结果。', 'Understand the task, delegate work, and bring the results together.'),
    task: run?.prompt || '', state: 'sleeping', statusText: officeStatus('idle', language),
    detail: t('等待当前任务开始。', 'Waiting for this task to start.'), configuration: { model: run?.model || task?.modelId },
    startedAt: witness?.startedAt || run?.createdAt, completedAt: run?.completedAt,
    elapsedMs: witness?.elapsedMs, usage: run?.usage || null, controllable: false,
  };
  if (run) {
    main.statusText = officeStatus(rawStatus, language);
    main.detail = t('显示当前任务最近一轮的记录。', 'Showing the latest run of this task.');
    if (run.anchorRestoredAt) { main.statusText = t('已回退', 'Reverted'); main.detail = t('本轮已回退，等待新任务。', 'This run was reverted. Waiting for another task.'); }
    else if (TERMINAL.has(rawStatus)) main.state = terminalState(rawStatus);
    else if (!live) { main.state = 'offline'; main.statusText = officeStatus('unknown', language); main.detail = t('记录尚未结束，但当前没有活动运行；请到对话查看恢复状态。', 'The record is unfinished, but no live run is attached. Check recovery in chat.'); }
    else if (paused) { main.state = 'waiting'; main.statusText = taskSuspensionLabel(witness?.pauseReasons || [], language); main.detail = t('任务已暂停，上下文与已完成操作保留。', 'The task is paused; context and completed work are retained.'); }
    else if (approval || run.clarifications?.some(q => q.status === 'pending') || current.some(r => /approval.required|clarification.required/.test(r.eventType || ''))) {
      main.state = 'attention'; main.statusText = t('等待你的确认', 'Waiting for you'); main.detail = t('返回对话处理确认或补充信息。', 'Return to chat to approve an action or answer a question.');
    } else {
      const mainRecords = current.filter(r => !r.agentId && r.actor !== 'subagent');
      const tool = mainRecords.find(r => r.kind === 'tool' || r.tool);
      const queue = mainRecords.find(r => r.kind === 'queue');
      if (tool) {
        const collecting = ['collect_subagents', 'wait_subagents'].includes(tool.tool);
        main.state = collecting ? 'waiting' : 'working';
        main.statusText = collecting ? t('等待子 Agent', 'Waiting for agents') : t('执行工具', 'Running a tool');
        main.detail = tool.tool || tool.title;
      } else if (queue) {
        main.state = 'waiting'; main.statusText = t('模型排队中', 'Model queued'); main.detail = queue.detail || main.statusText;
      } else if (String(run.content || '').trim()) {
        main.state = 'working'; main.statusText = t('正在输出', 'Responding'); main.detail = t('已收到本轮正文输出。', 'Response content has arrived in this round.');
      } else {
        main.state = 'waiting'; main.statusText = t('等待模型响应', 'Waiting for model');
        main.detail = t('尚无正文或工具进展；连接活动不代表实际执行。', 'No response content or tool progress yet; connection activity is not execution.');
      }
    }
  }

  const workers = new Map();
  for (const item of witness?.agents || []) if (item.agentId) workers.set(item.agentId, { ...item });
  for (const item of run?.subagents || []) if (item.agentId) workers.set(item.agentId, { ...workers.get(item.agentId), ...item });
  // A read-only runtime snapshot can fill queue/usage information. Discard its
  // state as soon as a newer worker event has changed the base array.
  if (live && snapshot?.runId === runId && snapshot.baseWorkers === run?.subagents) {
    for (const item of snapshot.workers || []) if (item.agentId) workers.set(item.agentId, { ...workers.get(item.agentId), ...item });
  }
  for (const record of records) if (record.agentId && !workers.has(record.agentId)) workers.set(record.agentId, { ...record, status: 'unknown' });
  const roster = [main];
  const consumed = new Set();
  function makeWorker(worker, profile, seatId) {
    const role = worker.role || profile?.template || 'explore';
    const [color, accessory] = skins[role] || skins.explore;
    const inFlight = LIVE.has(worker.status);
    const entry = {
      ...worker, id: seatId, agentId: worker.agentId, runId, role, roleName: officeRoleName(role, language),
      name: agentDisplayName({ profileId: worker.profileId || profile?.id, role, profileName: worker.profileName || profile?.name }, language), color, accessory,
      description: agentDescription(profile, language) || worker.task || '', state: 'sleeping', statusText: officeStatus(worker.status, language),
      detail: worker.summary || '', controllable: Boolean(live && inFlight && runId && worker.agentId),
    };
    if (TERMINAL.has(worker.status)) entry.state = terminalState(worker.status);
    else if (!live) {
      entry.state = 'offline'; entry.controllable = false;
      entry.statusText = t('无活动运行', 'Not running');
      entry.detail = t('本轮没有活动运行，保留最后已知记录。', 'No live run is attached; this is the last recorded state.');
    } else if (paused) {
      entry.state = 'waiting'; entry.statusText = t('随任务暂停', 'Task paused'); entry.detail = main.statusText;
    } else if (['approval', 'waiting_dependencies', 'queued'].includes(worker.phase)) {
      entry.state = worker.phase === 'approval' ? 'attention' : 'waiting';
      entry.statusText = worker.phase === 'approval' ? t('等待批准', 'Awaiting approval') : worker.phase === 'queued' ? t('等待可用工位', 'Queued for capacity') : t('等待依赖验收', 'Waiting for dependencies');
      entry.detail = worker.phase === 'waiting_dependencies' ? (worker.dependsOn || []).join(', ') : entry.statusText;
    } else if (inFlight) {
      const active = current.filter(r => r.agentId === worker.agentId);
      const tool = active.find(r => r.kind === 'tool' || r.tool);
      const queued = active.find(r => r.kind === 'queue');
      if (queued) { entry.state = 'waiting'; entry.statusText = t('模型排队中', 'Model queued'); entry.detail = queued.detail; }
      else if (worker.phase === 'tool' || tool) { entry.state = 'working'; entry.statusText = t('执行工具', 'Running a tool'); entry.detail = worker.currentTool || tool?.tool || ''; }
      else { entry.state = 'waiting'; entry.statusText = t('等待模型响应', 'Waiting for model'); entry.detail = t('等待模型返回可用结果。', 'Waiting for a usable model response.'); }
    } else { entry.state = 'offline'; entry.statusText = officeStatus('unknown', language); entry.controllable = false; }
    return entry;
  }
  for (const profile of profiles) {
    const matches = [...workers.values()].filter(w => (w.profileId || w.role) === profile.id);
    if (!matches.length) {
      const [color, accessory] = skins[profile.template] || skins.explore;
      roster.push({ id: `profile:${profile.id}`, profileId: profile.id, role: profile.template, roleName: officeRoleName(profile.template, language), name: agentDisplayName(profile, language), color, accessory,
        description: agentDescription(profile, language), state: 'sleeping', statusText: t('休息中', 'Idle'), detail: t('本轮尚未分配给这个角色。', 'This role has not been assigned in this run.'), controllable: false });
    }
    matches.forEach((w, index) => { consumed.add(w.agentId); const entry = makeWorker(w, profile, index === 0 ? `profile:${profile.id}` : `agent:${w.agentId}`); if (matches.length > 1) entry.name += ` ${index + 1}`; roster.push(entry); });
  }
  for (const worker of workers.values()) if (!consumed.has(worker.agentId)) roster.push(makeWorker(worker, null, `agent:${worker.agentId}`));
  return { run, runId, live, paused, roster, working: roster.filter(a => a.state === 'working').length, waiting: roster.filter(a => ['waiting', 'attention'].includes(a.state)).length };
}

// Keep the proven room layout. Additional instances get their own seats in
// additional zones, rather than occupying one shared avatar or disappearing.
export function officePageRoster(roster, page = 0) {
  const positions = [[-3.9, -2.5, .15], [-.55, .2, -.12], [2.75, -2.5, -.12], [2.75, .3, -.12], [-.55, 3.2, -.12], [2.75, 3.2, -.12]];
  return [roster[0], ...roster.slice(1 + page * 5, 6 + page * 5)].filter(Boolean).map((agent, index) => ({ ...agent, x: positions[index][0], z: positions[index][1], angle: positions[index][2] }));
}

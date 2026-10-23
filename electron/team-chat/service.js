import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callModelProvider } from '../runtime/provider-stream.js';
import { chatReasoningParameters } from '../../shared/model-reasoning.js';
import { clip, projectKey, roleEvidence, workerRecords, meetingMessages, meetingReplyMode, MEMBER_JOB_PROPOSAL_TOOL } from './context.js';
import { meetingPersona } from './persona.js';
import { createMemberJobs } from './jobs.js';
import { teamRecipients } from '../../shared/team-chat.js';
import { atomicWriteFile } from '../storage/atomic-file.js';
import { estimateConversationTokens, contextReserveTokens } from '../agent-context.js';

const ID = /^[\w.-]{1,120}$/;
const MAX_MESSAGES = 300;
const tokenUsage = usage => usage ? Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].filter(k => Number.isFinite(usage[k]) && usage[k] >= 0).map(k => [k, usage[k]])) : null;
// Chat has no work tools. Only the host's separate member executor can do work.
export function createTeamChatService({ dataDirectory, loadTask, loadTasks, loadRoles, resolveProvider,
  loadLive = async () => null, callProvider = callModelProvider, publish = () => {}, timeoutMs = 180000,
  executeJob, getJobResult, respondJobApproval, interruptJob }) {
  const stores = new Map(), writes = new Map(), active = new Map();
  let disposed = false;
  let taskIndex = null, taskIndexExpires = 0;
  const directory = () => join(typeof dataDirectory === 'function' ? dataDirectory() : dataDirectory, 'team-chats');
  async function scope(input) {
    if (!ID.test(input.taskId || '')) throw new Error('无效的任务标识。');
    const task = await loadTask(input.taskId);
    if (!task) throw new Error('任务尚未保存或已删除，请稍后重试。');
    const key = projectKey(task);
    const contextId = input.contextTaskId || task.id;
    if (!ID.test(contextId)) throw new Error('无效的任务标识。');
    const context = contextId === task.id ? task : await loadTask(contextId);
    if (!context || projectKey(context) !== key) throw new Error('只能查看本项目的任务。');
    return { key, task, context };
  }
  async function get(key) {
    if (!stores.has(key)) {
      const promise = (async () => {
        let value = { rooms: {} };
        try { value = JSON.parse(await readFile(join(directory(), key + '.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw new Error('团队消息历史读取失败，未覆盖原文件。'); }
        if (!value.rooms || typeof value.rooms !== 'object' || Array.isArray(value.rooms)) throw new Error('团队消息历史格式错误。');
        for (const room of Object.values(value.rooms)) {
          if (!Array.isArray(room.messages)) throw new Error('团队消息记录格式错误。');
          for (const m of room.messages) if (m.status === 'running') { m.status = 'interrupted'; m.error = '上次退出时回复未完成。'; }
        }
        return value;
      })();
      stores.set(key, promise);
      promise.catch(() => { if (stores.get(key) === promise) stores.delete(key); });
    }
    return stores.get(key);
  }
  async function save(key, store) {
    const bytes = JSON.stringify(store);
    const pending = (writes.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      await atomicWriteFile(join(directory(), key + '.json'), bytes);
    });
    writes.set(key, pending);
    try { await pending; } finally { if (writes.get(key) === pending) writes.delete(key); }
  }
  const emit = (key, room) => { try { publish({ projectKey: key, roomId: room.id, room: structuredClone(room) }); } catch { /* A detached UI does not cancel persistence. */ } };
  const roomKey = input => {
    if (input.roomId === 'group') return 'group';
    if (!/^role:[\w.-]{1,100}$/.test(input.roomId || '')) throw new Error('无效的角色会话。');
    return input.roomId;
  };
  async function roster() {
    const settings = await loadRoles();
    if (settings.error) throw new Error(settings.error);
    return [{ id: 'main', name: 'AporiaX · 主管', description: '理解需求、协调工作和总结团队结果', enabled: true, template: 'main' },
      ...settings.profiles.map(p => ({ id: p.id, name: p.name, description: p.description, instructions: p.instructions, enabled: p.enabled, template: p.template }))];
  }
  const publicRoles = roles => roles.map(({ instructions, ...role }) => role);
  async function projectTasks(s) {
    // Poll live evidence, not every project's entire history on every refresh.
    // Scope/selected-task authorization is always re-read by scope(), not cached.
    if (!taskIndex || Date.now() >= taskIndexExpires) {
      taskIndexExpires = Date.now() + 30000;
      taskIndex = Promise.resolve(loadTasks()).then(tasks => (tasks || []).map(t => ({ key: projectKey(t), id: t.id, title: clip(t.title, 160) })));
      taskIndex.catch(() => { taskIndex = null; });
    }
    const tasks = (await taskIndex).filter(t => t.key === s.key).map(({ key, ...task }) => task);
    const current = { id: s.task.id, title: clip(s.task.title, 160) };
    return [...tasks.filter(t => t.id !== current.id), current];
  }
  function roomFor(store, id, roles, create = false) {
    if (!Object.hasOwn(store.rooms, id)) {
      if (!create) return { id, title: id === 'group' ? '工作群' : roles.find(r => id === 'role:' + r.id)?.name || '已删除角色', messages: [], sequence: 0, readSequence: 0 };
      store.rooms[id] = { ...roomFor(store, id, roles), requests: [] };
    }
    return store.rooms[id];
  }
  function add(room, message) {
    const item = { id: randomUUID(), createdAt: new Date().toISOString(), ...message, sequence: ++room.sequence };
    room.messages.push(item); room.messages = room.messages.slice(-MAX_MESSAGES); return item;
  }
  const jobs = createMemberJobs({ dataDirectory, loadRoles, resolveProvider, executeJob,
    getResult: getJobResult, respondApproval: respondJobApproval, interrupt: interruptJob, publish,
    deliver: async (key, job) => {
      const store = await get(key), room = roomFor(store, job.roomId, [{ id: job.roleId, name: job.roleName }], true);
      const reportKey = `member-report:${job.id}`;
      if (room.reportKeys?.includes(reportKey)) { await save(key, store); return; }
      const en = job.language === 'en';
      const status = (en ? { completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed', needs_attention: 'Needs attention' }
        : { completed: '已完成', cancelled: '已取消', failed: '未能完成', needs_attention: '需要处理' })[job.status];
      const copy = job.result?.workspace?.mergeRequired ? (en ? '\nChanges are retained in a separate workspace, not applied to the original project.' : '\n改动保存在独立副本中，尚未应用到原项目。') : '';
      const full = String(job.result?.content || '');
      const summary = clip(full, 600) + (full.length > 600 ? (en ? '\n… Full result is in the member job.' : '\n…完整结果见独立任务。') : '');
      add(room, { id: reportKey, role: 'assistant', roleId: job.roleId, name: job.roleName, status: 'completed',
        roleTemplate: job.role?.template || job.roleId,
        content: `${en ? '@You' : '@你'} ${status}\n\n${summary}${copy}`, mentions: [{ type: 'user' }],
        memberJobId: job.id, jobStatus: job.status, resultDirectory: job.resultDirectory, origin: 'team-member', requestId: reportKey });
      room.reportKeys = [...(room.reportKeys || []), reportKey].slice(-500);
      await save(key, store); emit(key, room);
    },
  });
  async function send(input, s) {
    const id = roomKey(input), lock = s.key + ':' + id;
    if (!ID.test(input.requestId || '')) throw new Error('缺少有效请求标识。');
    if (active.has(lock)) throw new Error('此会话正在回复，请等待或停止。');
    if (active.size >= 2) throw new Error('团队聊天同时最多进行两场，请稍后再试。');
    const content = String(input.message || '').trim();
    if (!content || content.length > 8000) throw new Error('请输入 1–8000 字的消息。');
    const controller = new AbortController();
    active.set(lock, { controller, requestId: input.requestId });
    let store, room, timer, answer, flush, started = false, timedOut = false;
    try {
      const roles = await roster();
      const requested = id === 'group' ? teamRecipients(content, input.recipients, roles) : [id.slice(5)];
      if (!Array.isArray(requested) || requested.length > roles.length || new Set(requested).size !== requested.length) throw new Error('邀请成员列表无效。');
      const receivers = requested.map(roleId => {
        const role = roles.find(r => r.id === roleId);
        if (!role || !role.enabled) throw new Error('指定角色已删除或停用，不能发起新聊天。');
        return role;
      });
      const replyMode = meetingReplyMode(content, roles);
      const canProposeJob = replyMode === 'conversation' && Boolean(executeJob);
      const provider = await resolveProvider(input.providerId);
      const model = provider?.models?.find(m => m.id === input.modelId && !m.disabled);
      if (provider?.id !== input.providerId || provider.disabled || !model) throw new Error('所选聊天模型不可用，请重新选择。');
      store = await get(s.key); room = roomFor(store, id, roles, true);
      if (room.requests?.includes(input.requestId)) throw new Error('这条消息已提交，不会重复调用模型。');
      if (disposed || controller.signal.aborted) throw new Error('聊天已停止。');
      room.title = id === 'group' ? '工作群' : receivers[0].name;
      room.requests = [...(room.requests || []), input.requestId].slice(-500);
      add(room, { role: 'user', content, recipients: requested, taskId: s.context.id, taskTitle: clip(s.context.title, 160), requestId: input.requestId });
      started = true;
      await save(s.key, store); emit(s.key, room);
      const live = await loadLive(s.context);
      for (const role of receivers) {
        if (controller.signal.aborted) throw new Error('聊天已停止。');
        if (!(await roster()).some(r => r.id === role.id && r.enabled)) throw new Error('待回复角色已删除或停用，未继续调用。');
        const evidence = roleEvidence(s.context, role.id, live);
        evidence.memberJobs = (await jobs.request({ action: 'jobs:list', roomId: id }, s))
          .filter(job => job.roleId === role.id && job.status !== 'draft').slice(-4)
          .map(job => ({ instruction: clip(job.instruction, 600), status: job.status, result: clip(job.result?.content, 1200), copyNotApplied: job.result?.workspace?.mergeRequired === true }));
        const persona = await meetingPersona(role, input.language);
        const history = room.messages.filter(m => (m.role === 'user' || m.status === 'completed') && !(m.role === 'user' && m.requestId === input.requestId)).slice(-10);
        answer = add(room, { role: 'assistant', roleId: role.id, personaId: persona.id, name: role.name, content: '', status: 'running',
          requestId: input.requestId, taskId: s.context.id, taskTitle: clip(s.context.title, 160), evidence,
          modelId: model.id, providerId: provider.id, usage: null });
        await save(s.key, store); emit(s.key, room);
        const deadline = new AbortController();
        timer = setTimeout(() => { timedOut = true; deadline.abort(); }, timeoutMs);
        const signal = AbortSignal.any([controller.signal, deadline.signal]);
        const messages = meetingMessages({ role, persona, evidence, history, content, language: input.language, replyMode });
        const window = model.contextWindow || provider.contextWindow || 128000;
        const budget = window - contextReserveTokens(window);
        const toolTokens = canProposeJob ? estimateConversationTokens([{ role: 'system', content: JSON.stringify(MEMBER_JOB_PROPOSAL_TOOL) }]) : 0;
        while (messages.length > 3 && estimateConversationTokens(messages) + toolTokens > budget) messages.splice(2, 1);
        if (estimateConversationTokens(messages) + toolTokens > budget) throw new Error('当前资料超过所选模型的实际输入预算；请缩小本次交办或选择更大窗口。');
        const result = await callProvider({ provider: { ...provider, nativeModel: model }, signal, maxAttempts: 1,
          body: { model: model.id, messages, ...(canProposeJob && (model.supportsTools ?? provider.supportsTools) !== false ? { tools: [MEMBER_JOB_PROPOSAL_TOOL] } : {}), max_tokens: Math.min(2048, model.maxOutputTokens || provider.maxOutputTokens || 2048),
            ...chatReasoningParameters(model) },
          onEvent: event => {
            if (signal.aborted || answer.status !== 'running') return;
            if (event.type === 'response.text.reconciled') { answer.content = clip(event.content, 16000); emit(s.key, room); }
            if (event.type === 'response.delta' && typeof event.delta === 'string' && event.delta.length) {
              answer.content = (answer.content + event.delta).slice(0, 16000);
              answer.firstTokenAt ||= new Date().toISOString();
              if (!flush) flush = setTimeout(() => { flush = null; emit(s.key, room); }, 90);
            }
          },
        });
        answer.usage = tokenUsage(result.attemptUsage || result.usage);
        if (signal.aborted) throw new Error(deadline.signal.aborted ? '回复等待超过 3 分钟，已停止，不会自动重试。' : '聊天已停止。');
        if (result.message?.tool_calls?.length) {
          const calls = result.message.tool_calls;
          if (calls.length !== 1 || calls[0].function?.name !== 'propose_member_job' || !canProposeJob || (model.supportsTools ?? provider.supportsTools) === false) throw new Error('聊天模型请求了执行工具；本次未执行任何操作。');
          const args = JSON.parse(calls[0].function.arguments || '{}');
          if (!args || typeof args.instruction !== 'string' || Object.keys(args).some(key => key !== 'instruction')) throw new Error('成员任务草案无效，未启动任何工作。');
          answer.jobProposal = await jobs.request({ action: 'jobs:prepare', roomId: id, roleId: role.id, instruction: args.instruction, providerId: provider.id, modelId: model.id, language: input.language }, s);
          answer.content ||= String(input.language).startsWith('en') ? 'I have drafted the independent job. Please confirm the goal and workspace before starting.' : '已整理为独立任务，请核对目标和目录后确认启动。';
        }
        answer.content ||= clip(result.message?.content, 16000);
        if (!answer.content.trim()) throw new Error('模型没有返回正文，请手动重试。');
        answer.status = 'completed'; answer.completedAt = new Date().toISOString(); answer.sequence = ++room.sequence;
        clearTimeout(timer); clearTimeout(flush); timer = null; flush = null;
        await save(s.key, store); emit(s.key, room);
        answer = null;
      }
    } catch (error) {
      if (!started) throw error;
      if (answer) {
        answer.status = controller.signal.aborted ? 'interrupted' : 'failed';
        answer.error = controller.signal.aborted ? '已停止聊天回复。' : timedOut ? '回复等待超时，已停止，不会自动重试。' : clip(error.message, 500);
        answer.usage ||= tokenUsage(error.attemptUsage || error.usage);
        answer.completedAt = new Date().toISOString(); answer.sequence = ++room.sequence;
      } else add(room, { role: 'system', content: controller.signal.aborted ? '已停止，未继续邀请其他角色。' : clip(error.message, 500), status: 'failed' });
    } finally {
      clearTimeout(timer); clearTimeout(flush);
      try { if (started) { await save(s.key, store); emit(s.key, room); } }
      finally { active.delete(lock); }
    }
    return structuredClone(room);
  }
  return {
    async request(input = {}) {
      if (disposed) throw new Error('团队消息服务已关闭。');
      const s = await scope(input);
      if (String(input.action).startsWith('jobs:')) { roomKey(input); return jobs.request(input, s); }
      if (input.action === 'send') return send(input, s);
      const store = await get(s.key), roles = await roster();
      if (input.action === 'list') {
        const tasks = await projectTasks(s);
        const live = await loadLive(s.context);
        const ids = [...new Set(['group', ...roles.map(r => 'role:' + r.id), ...Object.keys(store.rooms)])];
        const rooms = ids.map(id => {
          const room = roomFor(store, id, roles), role = roles.find(r => id === 'role:' + r.id), last = room.messages.at(-1);
          return { id, title: id === 'group' ? '工作群' : role?.name || room.title, archived: id !== 'group' && !role,
            disabled: role?.enabled === false, preview: clip(last?.content || last?.error, 90), updatedAt: last?.createdAt,
            unread: room.messages.filter(m => m.role !== 'user' && m.status !== 'running' && m.sequence > room.readSequence).length,
            busy: active.has(s.key + ':' + id) };
        });
        rooms.sort((a, b) => a.id === 'group' ? -1 : b.id === 'group' ? 1 : (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
        return { projectKey: s.key, roles: publicRoles(roles), rooms, tasks, workers: workerRecords(s.context, live), live: Boolean(live), contextTaskId: s.context.id };
      }
      const id = roomKey(input), room = roomFor(store, id, roles);
      if (input.action === 'load') return structuredClone(room);
      if (input.action === 'read') {
        if (Object.hasOwn(store.rooms, id)) {
          room.readSequence = Math.max(room.readSequence || 0, Math.min(room.sequence, Number(input.sequence) || 0));
          await save(s.key, store);
        }
        return true;
      }
      if (input.action === 'cancel') { active.get(s.key + ':' + id)?.controller.abort(); return true; }
      throw new Error('未知的团队消息操作。');
    },
    listMemberJobs: () => jobs.listActive(),
    drainMemberJobs: () => jobs.drain(),
    dispose() { disposed = true; jobs.dispose(); for (const entry of active.values()) entry.controller.abort(); },
  };
}

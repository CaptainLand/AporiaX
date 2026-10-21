import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runHarness } from '../agent-runtime.js';
import { withDurableRun } from '../runtime/durable-run.js';
import { createRunControl } from '../runtime/run-control.js';
import { createLocalControlPolicy, withLocalControlPolicy } from '../control/policy.js';
import { runWithAgentBudget, planAgentBudget } from '../harness/agent-budget.js';
import { forkPublicHistory } from './temporary-context.js';
import { prepareTemporaryWorkspace } from './temporary-workspace.js';

// No task history store, run journal, global event bus or persistent chat files.
// File recovery is separate and intentionally survives discarded conversation.
export function createTemporarySideChatService({ dataDirectory, resolveProvider, loadTask,
  hydrateMessages = async messages => messages, execute = runHarness,
  prepareWorkspace = prepareTemporaryWorkspace, publish = () => {} }) {
  const sessions = new Map(), creating = new Map(); let disposed = false;
  const directory = () => typeof dataDirectory === 'function' ? dataDirectory() : dataDirectory;
  const keyOf = input => {
    if (!/^[\w.-]{1,120}$/.test(input.taskId || '') || typeof input.scope !== 'string' || !input.scope || input.scope.length > 2400) throw new Error('无效的临时聊天标识。');
    return JSON.stringify([input.taskId, input.scope]);
  };
  const view = session => structuredClone({ id: session.id, taskId: session.taskId, scope: session.scope,
    createdAt: session.createdAt, revision: session.revision || 0, inheritedMessages: session.fork.length, settings: session.settings,
    permission: session.permission, workspacePath: session.sourceWorkspacePath,
    messages: session.messages, approval: session.approval || null, paused: Boolean(session.active?.control.paused), closing: session.closing === true });
  const notify = session => {
    if (disposed || session.closed) return;
    session.revision = (session.revision || 0) + 1;
    try { publish({ type: 'session', taskId: session.taskId, scope: session.scope, sessionId: session.id, session: view(session) }); }
    catch { /* UI observers do not own execution. */ }
  };
  async function open(input) {
    const key = keyOf(input), previous = sessions.get(key);
    if (previous?.closingPromise) await previous.closingPromise;
    if (sessions.has(key)) return sessions.get(key);
    if (creating.has(key)) return creating.get(key);
    const pending = (async () => {
      const task = await loadTask(input.taskId);
      if (!task || task.id !== input.taskId) throw new Error('主任务不存在，无法创建临时分支。');
      const session = { id: `temporary-${randomUUID()}`, taskId: task.id, scope: input.scope,
        createdAt: new Date().toISOString(), fork: forkPublicHistory(input.history || task.messages), messages: [],
        sourceWorkspacePath: task.workspacePath || '', permission: task.permission === 'workspace-write' ? 'workspace-write' : 'read-only',
        settings: { providerId: task.providerId, modelId: task.modelId, thinking: task.thinking !== false, effort: task.effort || 'high' },
        language: task.language === 'en' ? 'en' : 'zh-CN', savedMain: null, previousRunId: null };
      if (disposed) throw new Error('临时聊天服务已关闭。');
      sessions.set(key, session); return session;
    })();
    creating.set(key, pending);
    try { return await pending; } finally { creating.delete(key); }
  }
  const requireSession = input => {
    const session = sessions.get(keyOf(input));
    if (!session || session.closed || session.id !== input.sessionId) throw new Error('临时聊天已关闭，请重新打开。');
    if (session.closing) throw new Error('正在关闭临时聊天，请等待执行停止。');
    return session;
  };
  async function approve(session, request) {
    const active = session.active;
    if (!active || active.controller.signal.aborted) return { approved: false };
    return new Promise(resolve => {
      const id = randomUUID();
      const finish = approved => { active.controller.signal.removeEventListener('abort', abort); session.approval = null; active.resolveApproval = null; notify(session); resolve({ approved, scope: 'once' }); };
      const abort = () => finish(false);
      active.resolveApproval = (approvalId, approved) => { if (approvalId !== id) throw new Error('此临时审批已失效。'); finish(approved); };
      active.controller.signal.addEventListener('abort', abort, { once: true });
      session.approval = { ...request, id, runId: active.runId, canRememberForRun: false }; notify(session);
      if (active.controller.signal.aborted) abort();
    });
  }
  async function launch(session, input) {
    const controller = new AbortController(), control = createRunControl(), runId = `temp-run-${randomUUID()}`;
    const active = { controller, control, runId, resolveApproval: null }; session.active = active;
    let timer;
    const message = { id: randomUUID(), role: 'assistant', runId, content: '', status: 'running', createdAt: new Date().toISOString(), route: [], steps: [] };
    session.messages.push({ id: randomUUID(), role: 'user', content: input.message || '', attachments: input.attachments || [], createdAt: message.createdAt }, message);
    const emit = event => {
      if (event.type === 'response.delta') message.content += event.delta || '';
      if (event.type === 'response.text.reconciled') message.content = event.content || '';
      if (event.type === 'response.reset') {
        if (message.content.trim()) (message.progressUpdates ||= []).push({ id: randomUUID(), kind: 'progress', title: '阶段进展', content: message.content, createdAt: new Date().toISOString() });
        message.content = '';
      }
      if (event.type === 'response.retry') message.content = '';
      if (event.type === 'witness.updated') message.witness = event.witness;
      if (event.type === 'tool.started') message.route.push({ ...event, id: event.callId, status: 'running', startedAt: event.timestamp || new Date().toISOString(), title: event.tool });
      if (event.type === 'tool.completed') {
        const route = message.route.findLast(item => item.callId === event.callId);
        if (route) Object.assign(route, event, { status: event.success ? 'completed' : 'failed', finishedAt: new Date().toISOString() });
      }
      if (event.type === 'assistant.progress') (message.progressUpdates ||= []).push({ content: event.content });
      if (!timer) timer = setTimeout(() => { timer = null; notify(session); }, 60);
    };
    notify(session);
    const operation = (async () => {
      try {
        const provider = await resolveProvider(input.providerId || session.settings.providerId);
        if (provider.id !== (input.providerId || session.settings.providerId) || provider.disabled) throw new Error('所选模型服务不可用。');
        const modelId = input.modelId || session.settings.modelId;
        if (!provider.models?.some(model => model.id === modelId && !model.disabled)) throw new Error('所选模型不可用。');
        session.settings = { providerId: provider.id, modelId, thinking: input.thinking !== false, effort: input.effort || session.settings.effort };
        controller.signal.throwIfAborted();
        session.workspace ||= await prepareWorkspace({ workspacePath: session.sourceWorkspacePath, dataDirectory: directory(), writable: session.permission === 'workspace-write', signal: controller.signal });
        const requestMessages = await hydrateMessages([...session.fork, ...session.messages.filter(item => item !== message).map(item => ({ role: item.role, content: item.content, attachments: item.attachments }))]);
        const request = { temporaryChat: true, builderOrchestration: false, runId, taskId: session.id,
          provider, modelId, workspacePath: session.workspace.workspacePath, permission: session.permission,
          approvalMode: 'manual', language: session.language, ...session.settings, messages: requestMessages,
          extensionPolicy: { skill: false, mcp: false, browser: false }, knowledgeEnabled: false,
          agentBudget: { maxTotalSubagents: 0, maxActiveSubagents: 0 },
          sandboxDataDirectory: join(directory(), 'temporary-file-recovery'),
          recoveryContext: session.savedMain ? { runId: session.previousRunId, contexts: { [session.previousRunId]: session.savedMain }, operations: [], unresolvedOperations: [] } : null,
          signal: controller.signal, control, onEvent: emit, requestApproval: request => approve(session, request) };
        // `settings` contains providerId, not a provider object. Never overwrite
        // the resolved host provider through renderer-controlled input.
        request.provider = provider;
        const policy = request.workspacePath ? createLocalControlPolicy({ clientId: 'temporary-chat', runId, workspaceRoot: request.workspacePath,
          strictWorkspace: true, permissionProfile: session.permission === 'workspace-write' ? 'workspace_edit' : 'read_only',
          capabilities: { commands: session.permission === 'workspace-write', browser: false, mcp: false },
          allowedProviderIds: [provider.id], allowedModelIds: [modelId],
          limits: { maxModelCalls: 100000, maxToolCalls: 100000, maxSubagents: 0, maxParallelAgents: 0, maxDurationSeconds: 86400 } }) : null;
        const context = { signal: controller.signal, control, operation: async () => {}, checkpoint: async () => {},
          context: async (id, json) => { if (id === runId) { session.savedMain = JSON.parse(json); session.previousRunId = runId; } },
          requestTrace: { runId, taskId: session.id, origin: 'temporary-chat' } };
        let result = await withDurableRun(context, () => runWithAgentBudget(planAgentBudget(request), {}, () => withLocalControlPolicy(policy, () => execute(request))));
        result = await session.workspace.finish(result, { cancelled: controller.signal.aborted, signal: controller.signal });
        if (result.integrated && result.content && session.workspace.workspacePath) result.content = result.content.split(session.workspace.workspacePath).join(session.sourceWorkspacePath);
        if (result.integrated && result.deliveryDetails && session.workspace.workspacePath) result.deliveryDetails = result.deliveryDetails.split(session.workspace.workspacePath).join(session.sourceWorkspacePath);
        Object.assign(message, { content: result.content || message.content, status: controller.signal.aborted ? 'interrupted' : result.status,
          deliveryDetails: result.deliveryDetails || null,
          usage: result.usage, witness: result.witness || message.witness, steps: result.steps || [],
          changes: result.changes || [], selfCheck: result.selfCheck, completedAt: new Date().toISOString() });
        message.unapplied = Boolean(result.retainedWorkspace);
        if (result.retainedWorkspace) message.retainedWorkspace = result.retainedWorkspace;
      } catch (error) {
        message.status = controller.signal.aborted ? 'interrupted' : 'failed';
        message.content ||= controller.signal.aborted ? '临时执行已停止。' : error.message;
        message.error = controller.signal.aborted ? '' : error.message;
      } finally {
        clearTimeout(timer); control.abort(); session.approval = null; message.completedAt ||= new Date().toISOString();
        if (session.active === active) session.active = null;
        notify(session);
      }
      return view(session);
    })();
    active.promise = operation; return operation;
  }
  return {
    async request(input = {}) {
      if (disposed) throw new Error('临时聊天服务已关闭。');
      if (['open', 'load'].includes(input.action)) return view(await open(input));
      if (input.action === 'close') {
        const key = keyOf(input); await creating.get(key);
        const session = sessions.get(key); if (!session || input.sessionId && input.sessionId !== session.id) return { closed: true };
        if (session.closingPromise) return session.closingPromise;
        session.closing = true; session.active?.controller.abort(); session.active?.control.abort(); notify(session);
        session.closingPromise = (async () => {
          await session.active?.promise;
          const retained = await session.workspace?.close?.() || {};
          session.closed = true; session.messages = []; session.fork = []; session.savedMain = null;
          sessions.delete(key); return { closed: true, ...retained };
        })().catch(error => { session.closing = false; session.closingPromise = null; notify(session); throw error; });
        return session.closingPromise;
      }
      const session = requireSession(input);
      if (input.action === 'cancel') { session.active?.controller.abort(); session.active?.control.abort(); return true; }
      if (input.action === 'pause' || input.action === 'resume') { session.active?.control[input.action](); notify(session); return view(session); }
      if (input.action === 'approve') {
        if (typeof input.approved !== 'boolean' || !session.active?.resolveApproval) throw new Error('此临时审批已失效。');
        session.active.resolveApproval(input.approvalId, input.approved); return true;
      }
      if (input.action === 'send') {
        if (typeof input.message !== 'string' || input.message.length > 100000 || !input.message.trim() && !input.attachments?.length) throw new Error('请输入临时聊天内容。');
        if (input.attachments != null && (!Array.isArray(input.attachments) || input.attachments.length > 6)) throw new Error('最多添加 6 个附件。');
        if (session.active) {
          const active = session.active;
          const [message] = await hydrateMessages([{ role: 'user', content: input.message, attachments: input.attachments || [], createdAt: new Date().toISOString() }]);
          if (session.closing || active.controller.signal.aborted) throw new Error('临时执行已停止，未追加要求。');
          if (session.active !== active) return launch(session, input);
          session.messages.push({ ...message, id: randomUUID() });
          active.control.enqueueSteering(message); notify(session); return view(session);
        }
        if ([...sessions.values()].filter(item => item.active).length >= 2) throw new Error('最多同时运行两个临时聊天。');
        return launch(session, input);
      }
      throw new Error('未知的临时聊天操作。');
    },
    dispose() { disposed = true; for (const session of sessions.values()) { session.active?.controller.abort(); session.active?.control.abort(); session.messages = []; session.fork = []; session.savedMain = null; } sessions.clear(); },
  };
}

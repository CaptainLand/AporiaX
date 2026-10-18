import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, serializeStorage } from '../storage/atomic-file.js';
import { clip } from './context.js';
import { memberWorkspaceIdentity, sameMemberWorkspace } from './workspace-identity.js';

const ACTIVE = new Set(['queued', 'running', 'waiting_approval']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs_attention']);
export const memberJobActive = job => ACTIVE.has(job.status);

// The host supplies execution; a conversation or model can only draft a job.
export function createMemberJobs({ dataDirectory, loadRoles, resolveProvider, executeJob,
  getResult = async () => null, respondApproval = () => false, interrupt = () => false,
  deliver, publish = () => {}, maxActive = 2 }) {
  const stores = new Map(), running = new Map();
  let disposed = false;
  const path = key => join(typeof dataDirectory === 'function' ? dataDirectory() : dataDirectory, 'team-member-jobs', key + '.json');
  const save = (key, store) => atomicWriteFile(path(key), JSON.stringify(store));
  const notify = key => { try { publish({ projectKey: key, type: 'member-jobs.updated' }); } catch { /* Delivery remains durable. */ } };
  async function get(key) {
    if (!stores.has(key)) {
      const pending = (async () => {
        let store;
        try { store = JSON.parse(await readFile(path(key), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw new Error('成员任务记录无法读取，未覆盖原文件。'); store = { version: 1, jobs: [] }; }
        if (store.version !== 1 || !Array.isArray(store.jobs)) throw new Error('成员任务记录格式无效。');
        for (const job of store.jobs) if (ACTIVE.has(job.status)) {
          // Never replay a possibly completed external action after a crash.
          const result = await getResult(job.runId);
          job.status = result ? result.status === 'completed' ? 'completed' : 'needs_attention' : 'needs_attention';
          job.result = result ? projectResult(result) : { content: '上次退出时任务未确认结束，请检查已保留的结果；不会自动重做。' };
          job.completedAt = new Date().toISOString(); job.reported = false; job.approval = null;
        }
        return store;
      })();
      stores.set(key, pending); pending.catch(() => stores.delete(key));
    }
    return stores.get(key);
  }
  const transaction = (key, fn) => serializeStorage(path(key), async () => {
    const store = await get(key);
    return fn(store);
  });
  async function flushReports(key, store) {
    for (const job of store.jobs) if (TERMINAL.has(job.status) && !job.reported) {
      await deliver(key, structuredClone(job));
      job.reported = true;
      await save(key, store);
    }
  }
  async function validateSelection(roleId, providerId, modelId, roomId) {
    if (roomId !== 'group' && roomId !== `role:${roleId}`) throw new Error('只能在该成员的私聊或工作群中派发。');
    const settings = await loadRoles();
    if (settings.error) throw new Error(settings.error);
    const role = roleId === 'main' ? { id: 'main', name: 'AporiaX', template: 'main', enabled: true, description: '独立处理用户交办的工作', instructions: '', tools: null, maxRequests: 24, maxRounds: 12 }
      : settings.profiles.find(role => role.id === roleId && role.enabled);
    if (!role) throw new Error('成员已删除或停用。');
    const provider = await resolveProvider(providerId);
    if (provider?.id !== providerId || provider.disabled || !provider.models?.some(m => m.id === modelId && !m.disabled)) throw new Error('所选工作模型已不可用。');
    if (role.model && role.model !== 'inherit') {
      let pair; try { pair = JSON.parse(role.model); } catch { pair = [providerId, role.model]; }
      if (!Array.isArray(pair) || pair[0] !== providerId || pair[1] !== modelId) throw new Error('此成员绑定了其他模型，请先在聊天设置中选择对应模型。');
    }
    return role;
  }
  function publicJob(job) {
    const { role, ...rest } = job;
    return structuredClone({ ...rest, roleTemplate: role?.template || job.roleId });
  }
  async function update(key, id, patch) {
    return transaction(key, async store => {
      const job = store.jobs.find(j => j.id === id);
      if (!job) throw new Error('成员任务不存在。');
      Object.assign(job, patch); await save(key, store); notify(key); return job;
    });
  }
  async function launch(key, id, controller) {
    try {
      const job = await transaction(key, async store => structuredClone(store.jobs.find(j => j.id === id)));
      controller.signal.throwIfAborted();
      const result = await executeJob(job, { signal: controller.signal, onEvent: async event => {
        if (event.type === 'approval.required') await update(key, id, { status: 'waiting_approval', approval: { id: event.approval.id, title: clip(event.approval.title, 200), command: clip(event.approval.command, 4000), reason: clip(event.approval.reason, 1000) } });
        else if (event.type === 'approval.resolved') await update(key, id, { status: 'running', approval: null });
        else if (event.type === 'member.workspace') await update(key, id, { resultDirectory: event.path });
      } });
      await update(key, id, { status: controller.signal.aborted ? 'cancelled' : result.status === 'completed' ? 'completed' : result.status === 'failed' ? 'failed' : 'needs_attention',
        result: projectResult(result), approval: null, completedAt: new Date().toISOString(), reported: false });
    } catch (error) {
      await update(key, id, { status: controller.signal.aborted ? 'cancelled' : 'failed', result: { content: clip(error.message, 2400) }, approval: null, completedAt: new Date().toISOString(), reported: false });
    } finally {
      running.delete(id);
      await transaction(key, async store => { await flushReports(key, store); notify(key); });
    }
  }
  return {
    async request(input, scope) {
      const key = scope.key, roomId = input.roomId;
      if (disposed) throw new Error('成员任务服务已关闭。');
      if (input.action === 'jobs:list') return transaction(key, async store => {
        await flushReports(key, store);
        return store.jobs.filter(job => job.roomId === roomId).map(publicJob);
      });
      if (input.action === 'jobs:prepare') {
        if (typeof executeJob !== 'function') throw new Error('当前客户端不支持成员独立执行，请重启更新后的开发版本。');
        const instruction = String(input.instruction || '').trim();
        if (!instruction || instruction.length > 8000) throw new Error('请输入 1–8000 字的任务目标。');
        if (!scope.context.workspacePath) throw new Error('请先为工作背景选择一个有工作目录的项目任务。');
        const role = await validateSelection(input.roleId, input.providerId, input.modelId, roomId);
        const workspaceIdentity = await memberWorkspaceIdentity(scope.context.workspacePath);
        return transaction(key, async store => {
          if (store.jobs.length >= 500) throw new Error('成员任务记录已达上限，请先整理历史记录。');
          const id = randomUUID();
          const job = { id, runId: `member-${id}`, taskId: `member-task-${id}`, origin: 'team-member', projectKey: key, roomId,
            contextTaskId: scope.context.id, workspacePath: scope.context.workspacePath, roleId: role.id, roleName: role.name, role,
            workspaceIdentity,
            instruction, providerId: input.providerId, modelId: input.modelId, language: input.language === 'en' ? 'en' : 'zh-CN',
            status: 'draft', createdAt: new Date().toISOString(), reported: false };
          store.jobs.push(job); await save(key, store); return publicJob(job);
        });
      }
      // Reserve admission synchronously, before any await, across all projects.
      if (typeof input.jobId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(input.jobId)) throw new Error('成员任务标识无效。');
      if (input.action === 'jobs:start' && !running.has(input.jobId)) {
        if (running.size >= maxActive) throw new Error('最多同时执行两项成员任务，请稍后再启动。');
        running.set(input.jobId, { key, controller: new AbortController(), preparing: true });
      }
      try {
        return await transaction(key, async store => {
          const job = store.jobs.find(j => j.id === input.jobId && j.roomId === roomId);
          if (!job) throw new Error('成员任务不属于当前会话。');
          if (input.action === 'jobs:start') {
            const admission = running.get(job.id);
            if (admission?.key !== key) throw new Error('成员任务归属不符。');
            if (job.status !== 'draft') {
              if (admission.preparing) running.delete(job.id);
              return publicJob(job); // Double-click never launches twice.
            }
            const role = await validateSelection(job.roleId, job.providerId, job.modelId, roomId);
            const ownActive = [...running].filter(([id, entry]) => id !== job.id && entry.roleId === role.id).length;
            if (ownActive >= Math.min(2, role.concurrency || 1)) throw new Error('此成员已达到并发任务上限。');
            if (job.contextTaskId !== scope.context.id || job.workspacePath !== scope.context.workspacePath) throw new Error('工作背景已变化，请重新创建任务。');
            if (!sameMemberWorkspace(job.workspaceIdentity, await memberWorkspaceIdentity(scope.context.workspacePath))) throw new Error('工作目录已被替换或指向发生变化，请重新确认。');
            if (JSON.stringify(role) !== JSON.stringify(job.role)) throw new Error('成员配置已变化，请重新确认任务。');
            admission.roleId = role.id;
            job.status = 'running'; job.startedAt = new Date().toISOString();
            try { await save(key, store); }
            catch (error) { job.status = 'draft'; delete job.startedAt; throw error; }
            admission.preparing = false;
            const operation = launch(key, job.id, admission.controller);
            admission.promise = operation;
            operation.catch(error => { admission.error = String(error.message); notify(key); });
            notify(key); return publicJob(job);
          }
          if (input.action === 'jobs:cancel') {
            if (job.status === 'draft') { job.status = 'cancelled'; job.reported = true; await save(key, store); return publicJob(job); }
            if (ACTIVE.has(job.status)) { running.get(job.id)?.controller.abort(); interrupt(job.runId); }
            return publicJob(job);
          }
          if (input.action === 'jobs:approve') {
            if (job.status !== 'waiting_approval' || input.approvalId !== job.approval?.id || typeof input.approved !== 'boolean') throw new Error('此审批已失效。');
            if (!respondApproval(job.runId, input.approvalId, { approved: input.approved, scope: 'once' })) throw new Error('此审批已失效。');
            return true;
          }
          throw new Error('未知的成员任务操作。');
        });
      } catch (error) {
        if (running.get(input.jobId)?.preparing && running.get(input.jobId)?.key === key) running.delete(input.jobId);
        throw error;
      }
    },
    listActive() { return [...running].map(([id, entry]) => ({ runId: `member-${id}`, taskId: `member-task-${id}`, origin: 'team-member', preparing: entry.preparing })); },
    async drain() { await Promise.all([...running.values()].map(entry => entry.promise).filter(Boolean)); },
    dispose() { disposed = true; for (const entry of running.values()) entry.controller.abort(); },
  };
}

function projectResult(result) {
  return { status: result.status, content: clip(result.content || result.summary || '任务已结束，但未返回正文。', 8000), usage: result.usage || null,
    workspace: result.workspace ? { path: result.workspace.path, sourcePath: result.workspace.sourcePath, mergeRequired: result.workspace.mergeRequired } : null,
    artifacts: (result.artifacts || []).slice(0, 100).map(a => ({ name: clip(a.name, 300), path: clip(a.path, 1000) })) };
}

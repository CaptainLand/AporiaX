import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { createHarnessTaskRuntime } from '../harness/task-runtime.js';
import { runHarness } from '../agent-runtime.js';
import { prepareControlWorkspace, finalizeControlWorkspace } from '../control/workspaces.js';
import { createLocalControlPolicy, withLocalControlPolicy } from '../control/policy.js';
import { runWithAgentBudget, planAgentBudget } from '../harness/agent-budget.js';
import { memberCanWrite } from './member-policy.js';
import { meetingPersona } from './persona.js';
import { applyRoleThinking } from '../runtime/role-capabilities.js';
import { createRoleLedger, withRoleBudget } from '../runtime/role-budget.js';
import { saveRuntimeContext } from '../runtime/durable-run.js';
import { memberWorkspaceIdentity, sameMemberWorkspace } from './workspace-identity.js';

// Separate runtime and journal: never shares the main task's IDs or event bus.
export function createMemberExecutor({ dataDirectory, resolveProvider, onActive = () => {}, infer = runHarness }) {
  const directory = () => typeof dataDirectory === 'function' ? dataDirectory() : dataDirectory;
  const runtime = createHarnessTaskRuntime({ dataDirectory: () => join(directory(), 'team-member-runtime'), onIdle: onActive });
  runtime.subscribeActiveRuns(onActive);
  return {
    runtime,
    async executeJob(job, { signal, onEvent }) {
      const provider = await resolveProvider(job.providerId);
      if (provider.id !== job.providerId || provider.disabled || !provider.models.some(m => m.id === job.modelId && !m.disabled)) throw new Error('成员任务模型已不可用。');
      const persona = await meetingPersona(job.role, job.language);
      const reasoning = applyRoleThinking(job.role, provider, job.modelId, { thinking: false, effort: 'low' });
      const writable = memberCanWrite(job.role);
      // Run_command is not an OS sandbox: approval remains mandatory even in copies.
      const commands = job.role.id === 'main' || job.role.template === 'verify';
      if (!sameMemberWorkspace(job.workspaceIdentity, await memberWorkspaceIdentity(job.workspacePath))) throw new Error('成员工作目录已变化，请重新确认。');
      const handle = await prepareControlWorkspace({ sourcePath: job.workspacePath, dataDirectory: join(directory(), 'team-member-data'), runId: job.runId, writable, signal });
      if (!sameMemberWorkspace(job.workspaceIdentity, await memberWorkspaceIdentity(handle.workspace.sourcePath))) throw new Error('工作目录在准备期间发生变化，未执行任务。');
      signal.throwIfAborted();
      await onEvent({ type: 'member.workspace', path: handle.workspacePath });
      const policy = createLocalControlPolicy({ clientId: 'team-member', runId: job.runId, workspaceRoot: await realpath(handle.workspacePath),
        permissionProfile: writable ? 'workspace_edit' : 'read_only', strictWorkspace: true,
        capabilities: { commands, browser: false, mcp: false }, allowedProviderIds: [provider.id], allowedModelIds: [job.modelId],
        limits: { maxModelCalls: Math.min(24, job.role.maxRequests || 24), maxToolCalls: 100, maxParallelAgents: 0, maxSubagents: 0, maxDurationSeconds: 1200 } });
      const abort = () => runtime.interrupt(job.runId);
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.min(1200, job.role.maxSeconds || 1200) * 1000); timer.unref?.();
      let events = Promise.resolve(), eventError = null;
      try {
        const request = { runId: job.runId, taskId: job.taskId, sourceUserId: job.id,
          workspacePath: handle.workspacePath, provider, modelId: job.modelId,
          memberRole: { ...job.role, name: persona.name, persona: persona.content },
          ...reasoning,
          permission: writable ? 'workspace-write' : 'read-only', approvalMode: 'manual', language: job.language,
          messages: [{ id: job.id, role: 'user', content: job.instruction }],
          extensionPolicy: { skill: false, mcp: false, browser: false }, knowledgeEnabled: false,
          agentBudget: { maxTotalSubagents: 0, maxActiveSubagents: 0 },
          roleSettings: { version: 1, profiles: [], builderLimit: 0, maxActive: 0, maxRequests: 24 },
          builderOrchestration: false,
          sandboxDataDirectory: join(directory(), 'team-member-data') };
        return await withLocalControlPolicy(policy, () => runWithAgentBudget(planAgentBudget(request), {}, () => runtime.start({
          runId: job.runId, taskId: job.taskId, clientId: 'team-member',
          metadata: { sourceUserId: job.id, workspacePath: handle.workspacePath, providerId: provider.id, modelId: job.modelId, prompt: job.instruction },
          onEvent: event => {
            events = events.then(() => onEvent(event)).catch(error => { eventError ||= error; abort(); });
          },
          execute: async ({ signal: runSignal, emit, requestApproval, control }) => {
            const combined = AbortSignal.any([runSignal, signal]); combined.throwIfAborted();
            try {
              const ledger = createRoleLedger(), total = { requests: 0 };
              const result = await withRoleBudget({ ledger, total, profile: job.role, limit: Math.min(24, job.role.maxRequests || 24, job.role.maxRounds || 24),
                persist: () => saveRuntimeContext('member-budget', { ledger, total }),
              }, () => infer({ ...request, signal: combined, control, onEvent: emit, requestApproval }));
              await events; if (eventError) throw eventError;
              return await finalizeControlWorkspace(handle, result);
            } catch (error) {
              const result = await finalizeControlWorkspace(handle, { status: combined.aborted ? 'interrupted' : 'failed', content: error.message, changes: [] });
              if (eventError) throw eventError;
              return result;
            }
          },
        })));
      } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); await events; }
    },
  };
}

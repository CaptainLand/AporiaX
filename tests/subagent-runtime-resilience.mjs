import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSubagentTask } from '../electron/runtime/subagent-loop.js';
import { createPermissionPolicy, ToolRegistry } from '../electron/agent-core.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';

const root = await realpath(await mkdtemp(join(tmpdir(), 'aporia-worker-resilience-')));
const call = (name, input, id = 'call') => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
const registry = new ToolRegistry(['read_file', 'write_file'].map(name => ({
  risk: name === 'read_file' ? 'read' : 'write',
  definition: { type: 'function', function: { name, description: name,
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] } } },
})));
const base = {
  agentId: 'resilience-worker', input: { role: 'explore', task: 'Inspect a file.', scope: ['.'] },
  modelId: 'fixture', modelConfig: { contextWindow: 128_000 }, workspaceRoot: root,
  parentPermissionPolicy: createPermissionPolicy('workspace-write'), approvalMode: 'full-auto',
  signal: new AbortController().signal, emit() {}, toolRegistry: registry, language: 'en',
  parseToolArguments: value => JSON.parse(value.function.arguments),
  executeAuthorizedTool: async ({ input }) => ({ modelResult: { path: input.path, content: 'unchanged' } }),
};
try {
  await writeFile(join(root, 'same.txt'), 'unchanged');
  const events = [];
  const progress = { type: 'response.progress', responseId: 'response-1', outputTokens: 123, estimated: true };
  const recovery = { type: 'response.recovery.status', responseId: 'response-1', phase: 'checking', attempt: 1, maxAttempts: 3 };
  const live = await runSubagentTask({ ...base, emit: event => events.push(event),
    provider: { supportsTools: true, async complete({ onStreamEvent }) {
      onStreamEvent({ type: 'response.activity' }); onStreamEvent(progress); onStreamEvent(recovery);
      return { message: { content: 'Inspection report.' } };
    } },
  });
  assert.equal(live.status, 'completed');
  assert.deepEqual(events.find(event => event.type === 'subagent.response.progress'), {
    ...progress, type: 'subagent.response.progress', agentId: base.agentId, role: 'explore',
  });
  assert.deepEqual(events.find(event => event.type === 'subagent.response.recovery.status'), {
    ...recovery, type: 'subagent.response.recovery.status', agentId: base.agentId, role: 'explore',
  });
  console.log('PASS live worker output/recovery events retain request identity and progress');

  const session = {}, reportedUsage = [];
  let requests = 0, executions = 0;
  const steered = await runSubagentTask({ ...base, session, onUsage: value => reportedUsage.push(value),
    executeAuthorizedTool: async () => { executions++; throw Error('stale action must not execute'); },
    provider: { supportsTools: true, async complete() {
      if (++requests === 1) {
        session.pendingGuidance = ['Only return the updated report.'];
        return { message: call('read_file', { path: 'stale.txt' }),
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
      }
      return { message: { content: 'Updated report.' },
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    } },
  });
  assert.equal(steered.status, 'completed'); assert.equal(executions, 0); assert.equal(requests, 2);
  assert.equal(steered.usage.total_tokens, 135);
  assert.equal(reportedUsage.reduce((sum, item) => sum + (item?.total_tokens || 0), 0), 135);
  console.log('PASS steering drops stale actions but retains both completed responses in usage');

  let repairedRequests = 0;
  const repairedUsage = [];
  const repaired = await runSubagentTask({ ...base, onUsage: value => repairedUsage.push(value),
    provider: { supportsTools: true, async complete() {
      if (++repairedRequests === 1) throw Object.assign(Error('truncated fixture'), {
        code: 'PROVIDER_FINISH_LENGTH', streamComplete: true, safeToRepair: true,
        partialMessage: { content: 'Preserved partial report.' },
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
      return { message: { content: 'Remaining report.' },
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        attemptUsage: { prompt_tokens: 15, completion_tokens: 6, total_tokens: 21 } };
    } },
  });
  assert.equal(repaired.status, 'completed'); assert.equal(repaired.usage.total_tokens, 51);
  assert.equal(repairedUsage.reduce((sum, value) => sum + (value?.total_tokens || 0), 0), 51);
  console.log('PASS failed-attempt usage and completed attempt aggregates are counted once');

  for (const finish of ['text', 'unsolicited-tools', 'error']) {
    let generated = 0, reads = 0;
    const protectedResult = await runSubagentTask({ ...base, session: {}, loopPolicy: { maxRepeatedEvidence: 2 },
      executeAuthorizedTool: async () => { reads++; return { modelResult: { path: 'same.txt', content: 'unchanged' } }; },
      provider: { supportsTools: true, async complete({ body }) {
        if (++generated <= 2) return { message: call('read_file', { path: 'same.txt' }, `read-${generated}`) };
        assert(body.tools.length, 'independent tools remain available after repetition');
        if (finish === 'error') throw Error('fixture summary unavailable');
        return { message: finish === 'text' || generated > 3 ? { content: 'Inspected the file; a different source can resolve the question.' }
          : call('write_file', { path: 'must-not-write.txt', content: 'unsafe' }, 'unsolicited') };
      } },
    });
    assert.equal(protectedResult.status, finish === 'error' ? 'failed' : 'completed'); assert.equal(reads, 2);
    assert.equal(generated, finish === 'unsolicited-tools' ? 4 : 3);
    assert.equal(protectedResult.completionGuard, undefined);
    assert(protectedResult.evidence.length >= 2); assert(protectedResult.summary.trim());
  }
  console.log('PASS progress warnings do not close tools; forged ungranted writes still fail and real provider errors remain honest');

  const priorFailure = { command: 'fixture test', cwd: '.' };
  let strategyRequests = 0;
  const blocked = await runSubagentTask({ ...base,
    loopPolicy: { strategyMode: 'strict', maxStrategyInterventions: 1 },
    session: { strategyHistory: { version: 1, failures: [], edits: [],
      plans: [{ hypothesis: 'Previously attempted repair.', priorFailure }], pending: priorFailure } },
    provider: { supportsTools: true, async complete({ body }) {
      strategyRequests++; assert(body.tools.length);
      return { message: { content: 'The prior repair did not resolve the issue; a new direction is needed.' } };
    } },
  });
  assert.equal(blocked.status, 'completed'); assert.equal(strategyRequests, 1);
  assert.equal(blocked.completionGuard, undefined);
  console.log('PASS strict strategy exhaustion no longer closes all diagnostic tools');

  let batchRequests = 0, staleWrites = 0;
  const batchResult = await runSubagentTask({ ...base, __builderIsolated: true,
    input: { role: 'builder', task: 'Inspect before editing.', scope: ['.'], writeScopes: ['same.txt'] },
    loopPolicy: { maxRepeatedEvidence: 2 },
    executeAuthorizedTool: async ({ toolName }) => {
      if (toolName === 'write_file') staleWrites++;
      return { modelResult: { path: 'same.txt', content: 'unchanged' } };
    },
    provider: { supportsTools: true, async complete({ body }) {
      if (++batchRequests === 1) return { message: { content: null, tool_calls: [
        ...call('read_file', { path: 'same.txt' }, 'one').tool_calls,
        ...call('read_file', { path: 'same.txt' }, 'two').tool_calls,
        ...call('write_file', { path: 'same.txt', content: 'authorized scoped edit' }, 'write').tool_calls,
      ] } };
      assert(body.tools.length);
      const skipped = body.messages.find(item => item.role === 'tool' && item.tool_call_id === 'write');
      assert.equal(JSON.parse(skipped.content).error, undefined);
      return { message: { content: 'The repeated inspection did not establish a safe edit.' } };
    } },
  });
  assert.equal(batchResult.status, 'completed'); assert.equal(staleWrites, 1); assert.equal(batchRequests, 2);
  console.log('PASS repeated reads do not prevent a separately authorized scoped edit in the same response');

  await writeFile(join(root, 'builder.txt'), 'before');
  for (const failAfterWrite of [false, true]) {
    const builderSession = {}, snapshots = [], persisted = [];
    let builderRound = 0;
    const built = await withDurableRun({ operation: async () => {}, context: async (_id, value) => persisted.push(JSON.parse(value)) }, () => runSubagentTask({
      ...base, agentId: 'snapshot-builder', input: { role: 'builder', task: 'Update the fixture.', scope: ['.'], writeScopes: ['builder.txt'] },
      __builderIsolated: true, session: builderSession,
      snapshotProvisional: async () => {
        const content = await readFile(join(root, 'builder.txt'), 'utf8'); snapshots.push(content);
        builderSession.provisionalChanges = [{ path: 'builder.txt', afterContent: content }];
      },
      executeAuthorizedTool: async ({ toolName, input }) => {
        if (toolName === 'write_file') {
          await writeFile(join(root, input.path), input.content);
          if (failAfterWrite) throw Error('fixture error after an effect');
          return { modelResult: { path: input.path }, changes: [{ path: input.path, afterContent: input.content }] };
        }
        return { modelResult: { path: input.path, content: `read-${builderRound}` } };
      },
      provider: { supportsTools: true, async complete() {
        builderRound++;
        if (builderRound <= 4) return { message: builderRound === 3
          ? call('write_file', { path: 'builder.txt', content: `after-${failAfterWrite}` }, 'write')
          : call('read_file', { path: 'builder.txt' }, `read-${builderRound}`) };
        return { message: { content: failAfterWrite ? 'The file changed, but the write tool reported an error.' : 'Updated the file.' } };
      } },
    }));
    assert.equal(built.status, 'completed'); assert.equal(builderRound, 5);
    assert.equal(snapshots.length, 2, 'only the potentially effectful tool boundary and terminal boundary scan');
    assert.deepEqual(snapshots, [`after-${failAfterWrite}`, `after-${failAfterWrite}`], JSON.stringify(built.steps));
    const afterEffect = persisted.find(value => value.session.steps?.some(step => step.name === 'write_file'));
    assert.equal(afterEffect.session.provisionalChanges[0].afterContent, `after-${failAfterWrite}`,
      'the first durable record after the write already contains its bytes, even after a tool error');
  }
  console.log('PASS read-only Builder rounds skip rescans; successful/failed mutations remain durable at their boundaries');
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('Subagent runtime resilience: PASS');

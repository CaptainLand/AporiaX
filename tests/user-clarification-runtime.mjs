import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarness } from '../electron/agent-runtime-core.js';
import { createClarificationSession } from '../electron/runtime/user-clarification.js';
import { createRunControl } from '../electron/runtime/run-control.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const originalFetch = globalThis.fetch;
const provider = { id: 'fixture', name: 'Fixture', vendor: 'openai', baseUrl: 'https://fixture.invalid/v1', apiKey: 'test-only',
  models: [{ id: 'fixture', supportsTools: true, contextWindow: 64000 }] };
const ask = { question: 'Should the report include costs?', reason: 'The audience changes what can be included.', uncertainty_key: 'report_audience' };
const call = (name, args, id = name) => ({ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = calls => new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: calls }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
const finish = () => response([call('finish_task', { status: 'completed', summary: 'Done without publishing.' })]);
const directory = await mkdtemp(join(tmpdir(), 'aporia-clarification-loop-'));
try {
  let requests = 0, required, sent = [], persisted;
  const control = createRunControl(), abort = new AbortController();
  const session = createClarificationSession({ control, signal: abort.signal, runId: 'main', taskId: 't',
    emit: event => { if (event.type === 'clarification.required') required = event.questions[0]; },
    persist: async value => { persisted = value; } });
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); sent.push(body); requests++;
    assert(body.tools.some(tool => tool.function.name === 'request_user_input'));
    return requests === 1 ? response([call('request_user_input', ask)]) : finish();
  };
  const task = runHarness({ runId: 'main', taskId: 't', provider, modelId: 'fixture', permission: 'read-only',
    signal: abort.signal, control, clarification: session, messages: [{ role: 'user', content: 'Prepare a report.' }] });
  for (let i = 0; i < 300 && !required; i++) await delay(10);
  assert(required, 'Model must be able to ask without a workspace');
  await delay(30); assert.equal(requests, 1, 'No inference polling while waiting');
  control.pause('user');
  await session.respond(required.id, { text: 'Internal report, include costs.' });
  await delay(30); assert.equal(requests, 1, 'Answer must not clear a manual pause');
  control.resume('user');
  const result = await task;
  assert.equal(result.status, 'completed');
  assert(sent[1].messages.some(message => message.role === 'tool' && /Internal report/.test(message.content)));
  assert(sent[1].messages.some(message => message.role === 'user' && /Internal report/.test(message.content)));
  assert(sent[1].messages.every(message => !Object.keys(message).some(key => key.startsWith('aporia'))));
  assert.equal(persisted.questions[0].status, 'answered');
  assert(result.witness.records.some(record => record.eventType === 'clarification.updated'));
  console.log('PASS real model loop: ask -> durable answer -> human context -> continue; no polling/manual pause bypass');
  const recoveryControl = createRunControl();
  const recoverySession = createClarificationSession({ state: structuredClone(persisted), control: recoveryControl,
    runId: 'restored', taskId: 't', emit() {}, persist: async () => assert.fail('Restore must not spend another question') });
  requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++; const messages = JSON.parse(options.body).messages;
    const receipts = messages.filter(message => message.role === 'tool' && message.tool_call_id === 'request_user_input');
    assert.equal(receipts.length, 1); assert.equal(JSON.parse(receipts[0].content).answer, 'Internal report, include costs.');
    assert.equal(messages.filter(message => message.role === 'user' && /Internal report/.test(message.content)).length, 1);
    return finish();
  };
  const recovered = await runHarness({ runId: 'restored', taskId: 't', provider, modelId: 'fixture', permission: 'read-only',
    control: recoveryControl, clarification: recoverySession, messages: [{ role: 'user', content: 'Prepare a report.' }],
    recoveryContext: { runId: 'main', contexts: { main: { kind: 'main', workspaceRoot: null,
      conversation: [{ role: 'system', content: 'old system' }, { role: 'user', content: 'Prepare a report.' },
        { role: 'assistant', content: null, tool_calls: [call('request_user_input', ask)] }],
    } } } });
  assert.equal(recovered.status, 'completed'); assert.equal(requests, 1); recoveryControl.abort();
  console.log('PASS answered-before-receipt crash recovery repairs the original tool result without re-asking');

  // A worker must not inherit a parent's ability, even if a model fabricates a call.
  requests = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); requests++;
    assert(!body.tools.some(tool => tool.function.name === 'request_user_input'));
    if (requests === 2) assert(body.messages.some(message => message.role === 'tool' && /CLARIFICATION_MAIN_ONLY/.test(message.content)));
    return requests === 1 ? response([call('request_user_input', ask, 'fabricated')]) : finish();
  };
  const child = await runHarness({ runId: 'child', provider, modelId: 'fixture', permission: 'read-only',
    clarification: session, messages: [{ role: 'user', content: 'Review the report.' }] });
  assert.equal(child.status, 'completed'); assert.equal(session.snapshot().length, 1);
  console.log('PASS child has no question capability and forged tool call is rejected');
  requests = 0;
  globalThis.fetch = async () => { requests++; return response([call('request_user_input', ask, 'invalid-' + requests)]); };
  const blocked = await runHarness({ runId: 'invalid-child', provider, modelId: 'fixture', permission: 'read-only',
    messages: [{ role: 'user', content: 'Do not repeatedly ask me.' }] });
  assert.equal(blocked.status, 'blocked'); assert.equal(requests, 3);
  console.log('PASS repeated invalid questioning stops after three rejected attempts without an infinite model loop');

  const mixedControl = createRunControl();
  const mixedSession = createClarificationSession({ control: mixedControl, runId: 'mixed', taskId: 't',
    emit: () => assert.fail('Mixed tool batch must not ask'), persist: async () => assert.fail('Mixed batch consumed budget') });
  requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    if (requests > 1) {
      const errors = JSON.parse(options.body).messages.filter(message => message.role === 'tool' && /CLARIFICATION_MUST_BE_ALONE/.test(message.content));
      assert.equal(errors.length, 2);
      return finish();
    }
    return response([call('request_user_input', ask, 'q'), { ...call('write_file', { path: 'should-not-exist.txt', content: 'unsafe' }, 'w'), index: 1 }]);
  };
  const mixed = await runHarness({ runId: 'mixed', provider, modelId: 'fixture', permission: 'workspace-write', workspacePath: directory,
    control: mixedControl, clarification: mixedSession, messages: [{ role: 'user', content: 'Prepare report; do not publish.' }],
    sandboxStatusResolver: async () => ({ available: false }) });
  assert.equal(mixed.status, 'completed'); await assert.rejects(access(join(directory, 'should-not-exist.txt')));
  console.log('PASS question + write in one batch executes neither and does not spend question budget');
  control.abort(); mixedControl.abort();
} finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }

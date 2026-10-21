import assert from 'node:assert/strict';
import { callModelProvider, createOpenAICompatibleProvider } from '../electron/runtime/provider-stream.js';
import { compileProviderWire } from '../electron/runtime/native-provider-codec.js';
import { normalizeProviderModels, normalizeProviderInput, publicProviderSummary } from '../electron/provider-config.js';
import { modelReasoningParameters, gptReasoningProfile, chatReasoningParameters } from '../shared/model-reasoning.js';
import { reasoningState } from '../src/models/reasoning-state.js';
import { reduceHarnessTaskEvent } from '../src/state/harness-event-reducer.js';
import { createSideChatService } from '../electron/side-chat/service.js';
import { createTeamChatService } from '../electron/team-chat/service.js';
import { defaultRoleSettings } from '../shared/professional-roles.js';
import { applyRoleThinking } from '../electron/runtime/role-capabilities.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, eventsResponse } from './goal-loop-fixtures.mjs';

const { test, finish } = suite('gpt-stream-reasoning');
const original = globalThis.fetch;
const provider = { id: 'gpt-fixture', name: 'GPT fixture', protocol: 'responses', vendor: 'openai', baseUrl: 'https://gpt-fixture.invalid/v1' };
const body = { model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'hi' }] };
const msg = (id, text, phase = 'final_answer') => ({ id, type: 'message', status: 'completed', role: 'assistant', phase, content: [{ type: 'output_text', text, annotations: [] }] });
const delta = (output_index, content_index, item_id, text, sequence_number) => ({ type: 'response.output_text.delta', output_index, content_index, item_id, delta: text, ...(sequence_number === undefined ? {} : { sequence_number }) });
const done = (output_index, item) => ({ type: 'response.output_item.done', output_index, item });
const terminal = output => ({ type: 'response.completed', response: { status: 'completed', ...(output === undefined ? {} : { output }), usage: { input_tokens: 7, output_tokens: 5 } } });
async function run(events) {
  let requests = 0; const received = [];
  globalThis.fetch = async () => { requests++; return eventsResponse(events); };
  const answer = await callModelProvider({ provider, body, onEvent: event => received.push(event) });
  assert.equal(requests, 1, 'reconcile the existing response; never ask the model again');
  return { answer, received };
}
try {
  await test('hi with complete output_item.done and empty terminal output reproduces and repairs mismatch', async () => {
    const item = msg('hi-message', '你好！');
    for (const output of [[], undefined]) {
      const { answer } = await run([delta(0, 0, item.id, '你好'), { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text: '你好！' }, done(0, item), terminal(output)]);
      assert.equal(answer.message.content, '你好！');
      assert.deepEqual(answer.message.aporiaNative.items, [item]);
    }
  });
  await test('interleaved output messages are checked per item and rendered in canonical order', async () => {
    const preamble = msg('comment', '我看一下。', 'commentary'), final = msg('final', '你好！');
    const { answer, received } = await run([delta(0, 0, preamble.id, '我'), delta(1, 0, final.id, '你好！'), delta(0, 0, preamble.id, '看一下。'), done(0, preamble), done(1, final), terminal([preamble, final])]);
    assert.equal(answer.message.content, '我看一下。你好！');
    assert.equal(received.filter(e => e.type === 'response.text.reconciled').length, 1);
    assert.equal(received.find(e => e.type === 'response.text.reconciled').content, answer.message.content);
    const next = compileProviderWire(provider, { ...body, messages: [...body.messages, { role: 'assistant', ...answer.message }] });
    assert.equal(next.body.input[1].phase, 'commentary'); assert.equal(next.body.input[2].phase, 'final_answer');
  });
  await test('missing suffix on earlier content part does not mix with the following part', async () => {
    const item = { ...msg('parts', ''), content: [{ type: 'output_text', text: 'First.' }, { type: 'output_text', text: 'Second.' }] };
    const { answer } = await run([delta(0, 0, item.id, 'First'), delta(0, 1, item.id, 'Second.'), terminal([item])]);
    assert.equal(answer.message.content, 'First.Second.');
  });
  await test('out-of-order indices and duplicate transport events do not duplicate text', async () => {
    const a = msg('a', 'A'), b = msg('b', 'B'), repeat = delta(2, 0, b.id, 'B', 11);
    const { answer } = await run([repeat, repeat, delta(0, 0, a.id, 'A', 12), done(0, a), done(2, b), terminal([])]);
    assert.equal(answer.message.content, 'AB');
  });
  await test('same-part disagreement, changed identity and missing final evidence still fail closed', async () => {
    for (const events of [
      [delta(0, 0, 'a', 'wrong'), terminal([msg('a', 'correct')])],
      [delta(0, 0, 'a', 'A'), terminal([msg('other', 'A')])],
      [delta(0, 0, 'a', 'A'), terminal([])],
      [delta(0, 0, 'a', 'A')],
      [delta(0, 0, 'a', 'A', 1), delta(0, 0, 'a', 'B', 1), terminal([msg('a', 'AB')])],
    ]) {
      let requests = 0; globalThis.fetch = async () => { requests++; return eventsResponse(events); };
      await assert.rejects(callModelProvider({ provider, body }), /MISMATCH|INCOMPLETE|SEQUENCE_INVALID/);
      assert.equal(requests, 1);
    }
  });
  await test('complete tool calls survive sparse terminal summary, but modified arguments are rejected', async () => {
    const call = { type: 'function_call', id: 'fc', call_id: 'call', name: 'read_file', arguments: '{"path":"a"}', status: 'completed' };
    const { answer } = await run([done(0, call), terminal([])]);
    assert.equal(answer.message.tool_calls[0].function.arguments, call.arguments);
    globalThis.fetch = async () => eventsResponse([done(0, call), terminal([{ ...call, arguments: '{"path":"b"}' }])]);
    await assert.rejects(callModelProvider({ provider, body }), /ITEM_FINAL_MISMATCH/);
  });
  await test('GPT UI levels equal actual wire values for direct and relayed models', async () => {
    for (const id of ['gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-sol']) {
      for (const vendor of ['openai', 'openai-compatible']) {
        const model = normalizeProviderModels([{ id, supportsThinking: false, thinkingMode: 'none' }], vendor)[0];
        const wrapper = createOpenAICompatibleProvider({ config: { ...provider, vendor }, model });
        assert.equal(model.supportsThinking, true, 'repair stale inferred false for known relayed GPT IDs');
        const state = reasoningState(model);
        assert.deepEqual(state.efforts, gptReasoningProfile(id).supportedEfforts);
        for (const effort of state.efforts) {
          const params = modelReasoningParameters(wrapper, { thinking: true, effort });
          assert.equal(params.reasoning_effort, effort);
          assert.equal(compileProviderWire(provider, { ...body, model: id, ...params }).body.reasoning.effort, effort);
        }
        assert.equal(chatReasoningParameters(model).reasoning_effort, 'low');
      }
    }
    assert.deepEqual(gptReasoningProfile('openai/gpt-6.1-sol-2026-10-01').supportedEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(gptReasoningProfile('gpt-6.1-sol-pro'), null, 'do not invent capabilities for variants');
  });
  await test('advertised account and explicit capabilities survive save/list and restrict supported efforts', () => {
    const record = normalizeProviderInput({ baseUrl: 'https://relay.invalid/v1', models: [{ id: 'gpt-6.1-sol', supportedEfforts: ['high', 'xhigh'], defaultEffort: 'xhigh' }] });
    const model = publicProviderSummary(record).models[0];
    assert.deepEqual(model.supportedEfforts, ['high', 'xhigh']); assert.equal(model.defaultEffort, 'xhigh');
    assert.equal(chatReasoningParameters(model).reasoning_effort, 'xhigh');
    const personal = { ...model, thinkingMode: 'personal-chatgpt' };
    assert.equal(modelReasoningParameters(personal, { modelId: personal.id, effort: 'xhigh' }).reasoning_effort, 'xhigh');
    assert.throws(() => modelReasoningParameters(personal, { modelId: personal.id, effort: 'max' }), /EFFORT_INVALID/);
    const disabled = normalizeProviderModels([{ id: 'gpt-6.1-sol', supportsThinking: false, thinkingMode: 'none', reasoningCapabilitySource: 'explicit' }], 'openai')[0];
    assert.equal(disabled.supportsThinking, false); assert.deepEqual(chatReasoningParameters(disabled), {});
  });
  await test('UI reconciliation replaces one response without turning its old ordering into a progress report', () => {
    const tasks = [{ id: 'task', messages: [{ id: 'answer', role: 'assistant', content: 'wrong arrival order', progressUpdates: [] }] }, { id: 'other', messages: [] }];
    const updated = reduceHarnessTaskEvent(tasks, { taskId: 'task', assistantId: 'answer' }, { type: 'response.text.reconciled', content: 'canonical order' });
    assert.equal(updated[0].messages[0].content, 'canonical order');
    assert.deepEqual(updated[0].messages[0].progressUpdates, []); assert.equal(updated[1], tasks[1]);
  });
  await test('real side/team services send GPT low effort and persist reconciled text, not duplicate fragments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aporia-gpt-chats-'));
    let side, team;
    try {
      const model = { ...gptReasoningProfile('gpt-6.1-sol'), id: 'gpt-6.1-sol', contextWindow: 64000, supportsTools: true };
      const config = { ...provider, models: [model] };
      const task = { id: 'task', projectId: 'project', workspacePath: '', messages: [], providerId: config.id, modelId: model.id };
      const deps = { dataDirectory: root, resolveProvider: async () => config, loadTask: async () => structuredClone(task),
        callProvider: async input => {
          assert.equal(input.body.reasoning_effort, 'low');
          input.onEvent({ type: 'response.delta', delta: 'B' }); input.onEvent({ type: 'response.delta', delta: 'A' });
          input.onEvent({ type: 'response.text.reconciled', content: 'AB' });
          return { message: { content: 'AB' }, usage: { input_tokens: 8, output_tokens: 2 } };
        } };
      side = createSideChatService(deps);
      const answer = await side.request({ action: 'send', taskId: 'task', mode: 'general', scope: 'global', providerId: config.id, modelId: model.id, message: 'hi', requestId: 'side' });
      assert.equal(answer.messages.at(-1).content, 'AB'); assert.equal(answer.messages.at(-1).status, 'completed');
      team = createTeamChatService({ ...deps, loadRoles: async () => defaultRoleSettings(), loadTasks: async () => [task] });
      const reply = await team.request({ action: 'send', taskId: 'task', roomId: 'group', providerId: config.id, modelId: model.id, message: 'hi', requestId: 'team' });
      assert.equal(reply.messages.at(-1).content, 'AB'); assert.equal(reply.messages.at(-1).status, 'completed');
      assert.equal(applyRoleThinking({ thinking: 'xhigh' }, config, model.id, {}).effort, 'xhigh');
      assert.throws(() => applyRoleThinking({ thinking: 'off' }, config, model.id, {}), /不能关闭/);
      const optional = { ...config, models: [{ ...gptReasoningProfile('gpt-5.5'), id: 'gpt-5.5' }] };
      assert.deepEqual(applyRoleThinking({ thinking: 'off' }, optional, 'gpt-5.5', {}), { thinking: false, effort: 'none' });
    } finally { side?.dispose(); team?.dispose(); await rm(root, { recursive: true, force: true }); }
  });
} finally { globalThis.fetch = original; }
await finish();

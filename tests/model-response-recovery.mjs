import assert from 'node:assert/strict';
import { createModelResponseRecovery, probeModelRequest, waitForModelRecovery } from '../electron/runtime/model-response-recovery.js';
import { callModelProviderOnce } from '../electron/runtime/provider-stream.js';
import { completeLoopRequest } from '../electron/runtime/loop-recovery.js';
import { createRunControl } from '../electron/runtime/run-control.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';
import { createTokenAccounting } from '../electron/agent-context.js';
import { createWitnessMonitor } from '../electron/witness-monitor.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test) { for (let n = 0; n < 500; n++) { if (test()) return; await delay(3); } assert.fail('Timed out waiting for test state'); }
const fixture = { id: 'stall-fixture', name: 'Fixture', apiKey: 'synthetic-key', baseUrl: 'https://model.invalid/v1' };
const body = { model: 'fixture', messages: [{ role: 'user', content: 'Do not repeat confirmed tools.' }] };
const encode = new TextEncoder();
const sse = value => 'data: ' + JSON.stringify(value) + '\n\n';
const chunk = (delta, finish_reason = null) => sse({ choices: [{ delta, finish_reason }] });
const originalFetch = globalThis.fetch;
let cases = 0;
async function test(name, run) { await run(); console.log('PASS', ++cases, name); }
function clock() {
  let now = 0, next = 1; const jobs = new Map();
  return { now: () => now,
    setTimeoutFn(fn, ms) { const id = next++; jobs.set(id, { fn, at: now + ms }); return id; },
    clearTimeoutFn(id) { jobs.delete(id); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const entry = [...jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at; jobs.delete(entry[0]); entry[1].fn();
        await new Promise(resolve => setImmediate(resolve));
      }
      now = target; await new Promise(resolve => setImmediate(resolve));
    },
  };
}
try {
  await test('only inactivity triggers checks, never overall thinking time; third waits indefinitely', async () => {
    const c = clock(), states = [];
    const watcher = createModelResponseRecovery({ ...c, onState: state => states.push(state) });
    for (let n = 0; n < 30; n++) { await c.advance(60_000); watcher.noteProgress(); }
    assert.equal(states.length, 0, '30 minutes of progressing inference must not recover');
    await c.advance(179_999); assert.equal(states.length, 0);
    await c.advance(1); assert.equal(states.at(-1).attempt, 1);
    await c.advance(180_000 * 2); assert.equal(states.at(-1).attempt, 3);
    const total = states.length; await c.advance(24 * 60 * 60_000);
    assert.equal(states.length, total, 'no fourth recovery or automatic termination');
    watcher.noteProgress(); await watcher.flush();
    assert.equal(states.at(-1).disposition, 'resumed'); assert.equal(watcher.snapshot().attempt, 0);
    watcher.dispose();
  });
  await test('queue transitions and user/system pause do not consume recovery budget', async () => {
    const c = clock(), states = []; let paused = true;
    const watcher = createModelResponseRecovery({ ...c, isPaused: () => paused, onState: s => states.push(s) });
    await c.advance(600_000); assert.equal(states.length, 0);
    watcher.setQueued(true); paused = false; await c.advance(600_000); assert.equal(states.length, 0);
    watcher.setQueued(false); await c.advance(179_999); assert.equal(states.length, 0);
    watcher.setQueued(false); await c.advance(1); assert.equal(states.at(-1).attempt, 1, 'duplicate admitted state cannot reset the clock');
    watcher.dispose();
  });
  await test('late progress cancels an in-flight recovery check; stale receipt cannot replay inference', async () => {
    const c = clock(); let release, retry = 0;
    const watcher = createModelResponseRecovery({ ...c,
      onAttempt: () => new Promise(resolve => { release = resolve; }), onSafeRetry: () => retry++ });
    await c.advance(180_000); watcher.noteProgress(); release({ safeRetry: true });
    await watcher.flush(); await delay(5); assert.equal(retry, 0); watcher.dispose();
  });
  await test('a Cloud retry requires an exact released zero-charge no-dispatch receipt; BYOK never probes arbitrary URLs', async () => {
    const id = '11111111-2222-4333-8444-555555555555', signal = new AbortController().signal;
    let calls = 0, receipt = { requestId: id, usageState: 'not-dispatched', billing: 'released', chargedMicros: 0 };
    const provider = { kind: 'aporia-cloud', authenticatedFetch: async (url, init) => {
      calls++; assert.equal(url, '/v1/requests/' + id); assert.equal(init.method, 'GET');
      return Response.json({ request: receipt });
    } };
    assert.equal((await probeModelRequest(provider, id, signal)).safeRetry, true);
    for (const patch of [{ chargedMicros: 1 }, { requestId: 'different' }, { usageState: 'pending' }, { billing: 'settled' }]) {
      const before = receipt; receipt = { ...receipt, ...patch };
      assert.notEqual((await probeModelRequest(provider, id, signal)).safeRetry, true); receipt = before;
    }
    assert.equal((await probeModelRequest(fixture, id, signal)).disposition, 'unsupported'); assert.equal(calls, 5);
  });
  await test('SSE keepalives cannot hide a stall; third check keeps original POST alive and accepts its late answer', async () => {
    let stream, posts = 0; const events = [];
    globalThis.fetch = async () => { posts++; return new Response(new ReadableStream({ start(controller) { stream = controller; } })); };
    const pending = callModelProviderOnce({ provider: fixture, body, onEvent: e => events.push(e), recoveryOptions: { intervalMs: 35 } });
    await until(() => stream);
    stream.enqueue(encode.encode(chunk({ content: '已保留。' })));
    const heartbeat = setInterval(() => stream.enqueue(encode.encode(': keepalive\n\n')), 5);
    try {
      await until(() => events.some(e => e.type === 'response.recovery.status' && e.attempt === 3 && e.state === 'waiting'));
      await delay(90); assert.equal(posts, 1); assert.equal(events.filter(e => e.state === 'checking').length, 3);
      stream.enqueue(encode.encode(chunk({ content: '迟到的结果。' }, 'stop') + 'data: [DONE]\n\n')); stream.close();
      const result = await pending; assert.equal(result.message.content, '已保留。迟到的结果。');
      assert(events.some(e => e.type === 'response.recovery.status' && e.disposition === 'resumed'));
    } finally { clearInterval(heartbeat); }
  });
  await test('streaming reasoning, tool arguments and actual output-token growth reset inactivity before UI throttling', async () => {
    for (const kind of ['reasoning', 'arguments', 'usage']) {
      let stream; const events = [];
      globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { stream = c; } }));
      const pending = callModelProviderOnce({ provider: fixture, body, onEvent: e => events.push(e), recoveryOptions: { intervalMs: 45 } });
      await until(() => stream);
      for (let n = 1; n <= 8; n++) {
        const data = kind === 'reasoning' ? chunk({ reasoning_content: 'thinking' }) : kind === 'usage'
          ? sse({ usage: { completion_tokens: n } }) : chunk({ tool_calls: [{ index: 0, id: n === 1 ? 'call-fixture' : '', function: { name: n === 1 ? 'read_file' : '', arguments: n === 1 ? '{"path":"' : 'a' } }] });
        stream.enqueue(encode.encode(data)); await delay(15);
      }
      const suffix = kind === 'arguments' ? chunk({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, 'tool_calls') : chunk({ content: 'done' }, 'stop');
      stream.enqueue(encode.encode(suffix + 'data: [DONE]\n\n')); stream.close();
      await pending; assert.equal(events.filter(e => e.type === 'response.recovery.status').length, 0, kind);
    }
  });
  await test('native reasoning streams are observed before the 500ms presentation throttle', async () => {
    for (const protocol of ['responses', 'anthropic-messages']) {
      let stream; const events = [];
      globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { stream = c; } }));
      const pending = callModelProviderOnce({ provider: { ...fixture, protocol }, body, onEvent: e => events.push(e), recoveryOptions: { intervalMs: 55 } });
      await until(() => stream);
      if (protocol === 'anthropic-messages') stream.enqueue(encode.encode(
        sse({ type: 'message_start', message: { usage: { input_tokens: 1 } } }) +
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })));
      for (let n = 0; n < 8; n++) {
        stream.enqueue(encode.encode(sse(protocol === 'responses'
          ? { type: 'response.reasoning_text.delta', delta: 'PRIVATE reasoning' }
          : { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE reasoning' } })));
        await delay(15);
      }
      const end = protocol === 'responses' ? sse({ type: 'response.completed', response: { status: 'completed', output: [
        { type: 'message', id: 'done', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }], usage: { input_tokens: 1, output_tokens: 2 } } })
        : sse({ type: 'content_block_stop', index: 0 }) + sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'done' } }) +
          sse({ type: 'content_block_stop', index: 1 }) + sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) + sse({ type: 'message_stop' });
      stream.enqueue(encode.encode(end)); stream.close();
      assert.equal((await pending).message.content, 'done');
      assert.equal(events.filter(e => e.type === 'response.recovery.status').length, 0, protocol);
      assert(!JSON.stringify(events).includes('PRIVATE reasoning'), 'no private reasoning in public progress events');
    }
  });
  await test('after a stalled stream disconnects the task waits without failing, preserves partial text and stops only on user request', async () => {
    let stream, posts = 0, settled = false; const events = [], checkpoints = [];
    const control = createRunControl(), abort = new AbortController();
    const monitor = createWitnessMonitor({ heartbeatMs: 0, control });
    monitor.observe({ type: 'turn.started' }); monitor.observe({ type: 'response.reset' });
    globalThis.fetch = async () => { posts++; return new Response(new ReadableStream({ start(c) { stream = c; } })); };
    const pending = withDurableRun({ control, checkpoint: c => checkpoints.push(c) }, () => completeLoopRequest({
      conversation: body.messages, contextCheckpoints: [], accounting: createTokenAccounting(), contextWindowTokens: 64000,
      getBody: messages => ({ ...body, messages }), signal: abort.signal,
      complete: (body, signal) => callModelProviderOnce({ provider: fixture, body, signal, onEvent: e => { events.push(e); monitor.observe(e); }, recoveryOptions: { intervalMs: 25 } }),
      onEvent: e => { events.push(e); monitor.observe(e); },
    })).finally(() => { settled = true; });
    await until(() => stream); stream.enqueue(encode.encode(chunk({ content: 'partial text retained' })));
    await until(() => events.some(e => e.attempt === 3 && e.state === 'waiting'));
    stream.error(new TypeError('terminated'));
    await until(() => control.snapshot().pauseReasons.includes('model-response'));
    assert.equal(settled, false); assert.equal(posts, 1);
    assert(checkpoints.some(c => c.content === 'partial text retained' && c.toolCallsExecuted === false));
    assert.equal(monitor.snapshot().status, 'paused'); assert(!events.some(e => ['turn.failed', 'run.finished'].includes(e.type)));
    control.setOnline(false); control.setOnline(true);
    assert(control.snapshot().pauseReasons.includes('model-response'), 'network event cannot restart exhausted recovery');
    abort.abort(); control.abort(); await assert.rejects(pending, { name: 'AbortError' });
    monitor.dispose();
  });
  await test('only confirmed non-dispatch can rotate a Cloud request; a contradictory receipt cannot replay partial output', async () => {
    for (const hasOutput of [false, true]) {
      const id = '11111111-2222-4333-8444-555555555555';
      const control = createRunControl(), abort = new AbortController();
      let posts = 0, queries = 0, stream;
      const cloud = { ...fixture, kind: 'aporia-cloud', authenticatedFetch: async (path, init) => {
        if (init.method === 'GET') { queries++; return Response.json({ request: { requestId: id, usageState: 'not-dispatched', billing: 'released', chargedMicros: 0 } }); }
        posts++;
        if (posts > 1) return new Response(chunk({ content: 'safe retry result' }, 'stop') + 'data: [DONE]\n\n', { headers: { 'x-aporia-request-id': id } });
        return new Response(new ReadableStream({ start(c) { stream = c;
          init.signal.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        } }), { headers: { 'x-aporia-request-id': id } });
      } };
      const pending = withDurableRun({ control, checkpoint: () => {} }, () => completeLoopRequest({ conversation: body.messages,
        contextCheckpoints: [], accounting: createTokenAccounting(), contextWindowTokens: 64000, getBody: () => body,
        signal: abort.signal, complete: (body, signal) => callModelProviderOnce({ provider: cloud, body, signal, recoveryOptions: { intervalMs: 30 } }),
      }));
      pending.catch(() => {});
      await until(() => stream);
      if (hasOutput) stream.enqueue(encode.encode(chunk({ content: 'confirmed prefix' })));
      await until(() => queries > 0);
      if (hasOutput) {
        await delay(15); assert.equal(posts, 1);
        stream.enqueue(encode.encode(chunk({ content: ' original result' }, 'stop') + 'data: [DONE]\n\n')); stream.close();
        assert.equal((await pending).message.content, 'confirmed prefix original result');
      } else {
        assert.equal((await pending).message.content, 'safe retry result'); assert.equal(posts, 2);
      }
      control.abort();
    }
  });
  await test('a closed partial response cannot be regenerated even if a later receipt contradicts its output', async () => {
    const control = createRunControl(), abort = new AbortController(); let settled = false, probes = 0;
    const pending = waitForModelRecovery({ error: { modelResponseRecovery: { attempt: 2, receivedModelData: true },
      partialMessage: { content: 'retain this prefix' }, recoverModelConnection: async () => { probes++; return { disposition: 'not-dispatched', safeRetry: true }; } },
      control, signal: abort.signal, onState: () => {}, intervalMs: 5 }).finally(() => { settled = true; });
    await until(() => probes === 1); await delay(20);
    assert.equal(settled, false); assert(control.paused);
    abort.abort(); control.abort(); await assert.rejects(pending, { name: 'AbortError' });
  });
  await test('restored exhausted budget does not restart automatic checks; user stop cancels pending waits', async () => {
    const control = createRunControl(), abort = new AbortController(); let probes = 0;
    const pending = waitForModelRecovery({ error: { modelResponseRecovery: { attempt: 3 }, recoverModelConnection: async () => { probes++; } },
      control, signal: abort.signal, onState: () => {}, intervalMs: 5 });
    await delay(25); assert.equal(probes, 0); assert(control.paused);
    control.resume('model-response'); await until(() => probes > 0);
    abort.abort(); control.abort(); await assert.rejects(pending, { name: 'AbortError' });
  });
  console.log(`PASS ${cases} model recovery cases; synthetic requests only, no credentials or paid services used.`);
} finally { globalThis.fetch = originalFetch; }

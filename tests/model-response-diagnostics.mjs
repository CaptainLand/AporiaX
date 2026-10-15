import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configureModelResponseDiagnostics, drainModelResponseDiagnostics } from '../electron/runtime/model-response-diagnostics.js';
import { callModelProviderOnce } from '../electron/runtime/provider-stream.js';
const originalFetch = globalThis.fetch;
const root = await mkdtemp(join(tmpdir(), 'aporiax-response-diagnostic-'));
const provider = { id: 'test', name: 'Test', vendor: 'deepseek', protocol: 'deepseek-chat', baseUrl: 'https://example.invalid/v1', apiKey: 'SECRET_API_KEY' };
const body = { model: 'test-model', messages: [{ role: 'user', content: 'SECRET_INPUT_NOT_TO_SAVE' }], max_tokens: 8192 };
let requests = 0, checks = 0;
const sse = events => new Response(events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const chat = () => sse([
  { choices: [{ index: 0, delta: { reasoning_content: 'public sample thinking' } }] },
  { choices: [{ index: 0, delta: { content: 'sample answer' }, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, unusual: 'SECRET_USAGE_FIELD' } }, '[DONE]',
]);
const call = options => callModelProviderOnce({ provider, body, ...options });
const test = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const configure = directory => configureModelResponseDiagnostics({ dataDirectory: () => directory });
const records = async directory => {
  await drainModelResponseDiagnostics();
  const dir = join(directory, 'diagnostics', 'model-responses');
  for (let attempt = 0; attempt < 200; attempt++) {
    const names = await readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    const result = await Promise.all(names.filter(f => f.endsWith('.json')).map(async f => JSON.parse(await readFile(join(dir, f), 'utf8'))));
    if (result.length && result.every(r => r.requestOutcome !== 'receiving')) return result;
    await new Promise(done => setTimeout(done, 10));
  }
  throw new Error('Timed out waiting for diagnostic-only background writes.');
};
try {
  await test('OFF by default; original result and request count unchanged', async () => {
    globalThis.fetch = async () => { requests++; return chat(); };
    const result = await call(); assert.equal(result.message.reasoning_content, 'public sample thinking');
    assert.equal(result.message.content, 'sample answer'); assert.equal(requests, 1);
    assert.deepEqual(await readdir(root), []);
  });
  await test('one existing DeepSeek stream captured once; no inputs/keys/extra requests/UI changes', async () => {
    const dir = join(root, 'deepseek'); configure(dir); const events = [];
    const result = await call({ cloudTrace: { logicalRequestId: 'logical', runId: 'run', taskId: 'task' }, onEvent: e => events.push(e.type) });
    const [record] = await records(dir);
    assert.equal(record.reasoning, result.message.reasoning_content); assert.equal(record.output, result.message.content);
    assert.equal(record.status, 'completed'); assert.equal(record.requestOutcome, 'completed');
    assert.equal(record.runId, 'run'); assert.equal(record.requestId, 'logical'); assert.equal(record.localOnly, true);
    assert.deepEqual(record.usage, { prompt_tokens: 10, completion_tokens: 5 });
    assert.doesNotMatch(JSON.stringify(record), /SECRET_/); assert.ok(events.includes('response.delta'));
    assert.ok(!events.some(e => /reasoning|thinking/.test(e)));
    await call(); assert.equal((await records(dir)).length, 1); assert.equal(requests, 3);
  });
  await test('parallel requests cannot both consume one-shot capture', async () => {
    const dir = join(root, 'parallel'); configure(dir);
    await Promise.all([call(), call()]); assert.equal((await records(dir)).length, 1); assert.equal(requests, 5);
  });
  await test('native Anthropic capture observes native events and does not duplicate output', async () => {
    const dir = join(root, 'claude'); configure(dir);
    globalThis.fetch = async () => { requests++; return sse([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'public native sample' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SECRET_SIGNATURE' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'native answer' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' },
    ]); };
    const result = await call({ provider: { ...provider, vendor: 'anthropic', protocol: 'anthropic-messages' } });
    const [record] = await records(dir); assert.equal(record.reasoning, 'public native sample');
    assert.equal(record.output, result.message.content); assert.equal(record.output, 'native answer');
    assert.equal(record.status, 'completed'); assert.doesNotMatch(JSON.stringify(record), /SECRET_/);
  });
  await test('provider error saves failure metadata without raw error or another request', async () => {
    const dir = join(root, 'failed'); configure(dir); const before = requests;
    globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ error: { message: 'SECRET_ERROR' } }), { status: 401, headers: { 'content-type': 'application/json' } }); };
    await assert.rejects(call()); const [record] = await records(dir);
    assert.equal(record.requestOutcome, 'failed'); assert.equal(record.status, 'incomplete');
    assert.equal(requests, before + 1); assert.doesNotMatch(JSON.stringify(record), /SECRET_/);
  });
  await test('truncated transport retains partial reasoning and response status', async () => {
    const dir = join(root, 'partial'); configure(dir);
    globalThis.fetch = async () => { requests++; return sse([{ choices: [{ delta: { reasoning_content: 'partial public sample' } }] }]); };
    await assert.rejects(call(), /INCOMPLETE/); const [record] = await records(dir);
    assert.equal(record.reasoning, 'partial public sample'); assert.equal(record.status, 'incomplete'); assert.equal(record.requestOutcome, 'failed');
  });
  await test('storage failure cannot fail or retry the normal model result', async () => {
    const blocked = join(root, 'not-directory'); await writeFile(blocked, 'file'); configure(blocked);
    globalThis.fetch = async () => { requests++; return chat(); }; const before = requests;
    const result = await call(); assert.equal(result.message.content, 'sample answer'); assert.equal(requests, before + 1);
    await drainModelResponseDiagnostics();
  });
  await test('disarming prevents further recording', async () => {
    configureModelResponseDiagnostics(); const result = await call(); assert.equal(result.message.content, 'sample answer');
  });
  console.log(`${checks} opt-in diagnostic integration checks passed; all fetches mocked.`);
} finally {
  globalThis.fetch = originalFetch; configureModelResponseDiagnostics();
  await drainModelResponseDiagnostics();
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
  await rm(root, { recursive: true, force: true });
}

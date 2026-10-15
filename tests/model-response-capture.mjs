import assert from 'node:assert/strict';
import { captureSse, createResponseCapture } from '../electron/runtime/model-response-capture-core.js';
const options = { requestId: 'r', attemptId: 'a', phaseId: 'p' };
const sse = items => items.map(item => `data: ${typeof item === 'string' ? item : JSON.stringify(item)}\r\n\r\n`).join('');
async function* byteChunks(text) { const bytes = new TextEncoder().encode(text); for (let i = 0; i < bytes.length; i += 3) yield bytes.slice(i, i + 3); }
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };

const deepseek = await captureSse(byteChunks(': keepalive\r\n\r\n' + sse([
  { choices: [{ index: 0, delta: { reasoning_content: '公开思考示例🙂' } }] },
  { choices: [{ index: 0, delta: { content: '最终' } }] },
  { choices: [{ index: 0, delta: { content: '答案' }, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 8 } }, '[DONE]',
])), options);
check('split UTF-8, reasoning/output separated, identities and usage', () => {
  assert.equal(deepseek.reasoning, '公开思考示例🙂'); assert.equal(deepseek.output, '最终答案');
  assert.equal(deepseek.status, 'completed'); assert.equal(deepseek.usage.completion_tokens, 8);
  assert.ok(deepseek.events.some(e => e.kind === 'keepalive')); assert.ok(deepseek.events.every(e => e.phaseId === 'p' && e.attemptId === 'a'));
});
const anthropic = createResponseCapture({ ...options, protocol: 'anthropic-messages' });
for (const e of [
  { type: 'message_start', message: { usage: { input_tokens: 4 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '接口公开文本' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SECRET_SIGNATURE' } },
  { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'SECRET_OPAQUE' } },
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '答案' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' },
]) anthropic.accept(e);
check('Anthropic readable thinking only, no signatures or redacted bytes', () => {
  const r = anthropic.end(); assert.equal(r.reasoning, '接口公开文本'); assert.equal(r.output, '答案');
  assert.equal(r.opaqueBlocks, 1); assert.equal(r.status, 'completed'); assert.equal(r.usage.input_tokens, 4);
  assert.doesNotMatch(JSON.stringify(r), /SECRET_/);
});
const responses = createResponseCapture({ ...options, protocol: 'responses' });
responses.accept({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '公开摘要' });
responses.accept({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '答' });
responses.accept({ type: 'response.completed', response: { output: [
  { type: 'reasoning', encrypted_content: 'SECRET_ENCRYPTED', summary: [{ type: 'summary_text', text: '公开摘要' }] },
  { type: 'message', content: [{ type: 'output_text', text: '答案' }] },
], usage: { output_tokens: 5 } } });
check('Responses public summary, no duplicates, encrypted bytes excluded', () => {
  const r = responses.end(); assert.equal(r.reasoning, '公开摘要'); assert.equal(r.output, '答案');
  assert.equal(r.reasoningSource, 'provider-public-summary'); assert.doesNotMatch(JSON.stringify(r), /SECRET_/);
});
check('keepalive is not thinking and EOF alone is not completion', () => {
  const r = createResponseCapture(options); r.accept(null); r.accept({ choices: [] });
  assert.equal(r.end().status, 'incomplete'); assert.equal(r.snapshot().reasoning, '');
});
check('errors retain partial text, do not log raw error payload', () => {
  const r = createResponseCapture(options); r.accept({ choices: [{ delta: { content: 'partial' } }] });
  r.accept({ error: { message: 'SECRET_PROVIDER_MESSAGE' } }); const s = r.end();
  assert.equal(s.status, 'failed'); assert.equal(s.output, 'partial'); assert.doesNotMatch(JSON.stringify(s), /SECRET_/);
});
check('capture limits do not split emoji or imply full capture', () => {
  const r = createResponseCapture({ ...options, maxChars: 2 }); r.accept({ choices: [{ delta: { content: 'a🙂b' } }] });
  assert.equal(r.snapshot().output, 'a'); assert.equal(r.snapshot().truncated, true);
});
check('snapshots cannot mutate collector and attempts stay separate', () => {
  const r = createResponseCapture(options); const s = r.snapshot(); s.events.push({ kind: 'fake' });
  assert.equal(r.snapshot().events.length, 0); assert.equal(createResponseCapture({ ...options, attemptId: 'b' }).snapshot().reasoning, '');
});
try { await captureSse(byteChunks('data: {SECRET_INVALID_JSON}\n\n'), options); assert.fail(); }
catch (e) { assert.equal(e.message, 'Malformed SSE JSON event.'); assert.equal(e.capture.status, 'interrupted'); checks++; }
try { await captureSse(byteChunks('data: ' + 'x'.repeat(100)), { ...options, maxEventChars: 20 }); assert.fail(); }
catch (e) { assert.match(e.message, /exceeds/); checks++; }
const incomplete = await captureSse(byteChunks(sse([{ choices: [{ delta: { reasoning_content: 'partial thinking' } }] }])), options);
check('interrupted stream preserves partial provider fields', () => { assert.equal(incomplete.status, 'incomplete'); assert.equal(incomplete.reasoning, 'partial thinking'); });
console.log(`${checks} offline capture checks passed; no live model requests.`);

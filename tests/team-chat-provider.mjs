import assert from 'node:assert/strict';
import { callModelProvider } from '../electron/runtime/provider-stream.js';
const original = globalThis.fetch;
let attempts = 0;
try {
  globalThis.fetch = async () => { attempts++; return new Response(JSON.stringify({ error: { message: 'fixture failure' } }), { status: 503, headers: { 'Content-Type': 'application/json' } }); };
  await assert.rejects(callModelProvider({ provider: { id: 'test', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:19876/v1', protocol: 'chat-completions' },
    body: { model: 'mock', messages: [{ role: 'user', content: 'test' }], max_tokens: 2048 }, maxAttempts: 1 }));
  assert.equal(attempts, 1, 'team chat cannot automatically retry a failed paid request');
  console.log('PASS team chat provider: retryable 503 makes exactly one HTTP attempt.');
} finally { globalThis.fetch = original; }

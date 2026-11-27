import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCloudEndpoints } from '../electron/account/cloud-endpoints.js';
import { cloudAuthRecoveryFor } from '../shared/cloud-auth-response.js';
import { callModelProvider } from '../electron/runtime/provider-stream.js';
import { createAporiaCloudProvider } from '../electron/provider-config.js';
import { createLoopRequestIdentity, withLoopRequestIdentity } from '../electron/runtime/cloud-request-identity.js';

const directory = await mkdtemp(join(tmpdir(), 'aporia-cloud-auth-'));
const options = { apiBaseUrl: 'https://api.example.invalid', webBaseUrl: 'https://web.example.invalid',
  modelGatewayBaseUrl: 'https://gateway.example.invalid', endpointManifest: join(directory, 'missing') };
const endpoints = loadCloudEndpoints(options, {});
const previousFetch = globalThis.fetch, wallClock = Date.now;
globalThis.__authTestElectron = { app: { getPath: () => directory, getVersion: () => 'fixture' }, shell: {},
  safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: bytes => bytes.toString() } };
const source = (await readFile(new URL('../electron/account/desktop-account-runtime.js', import.meta.url), 'utf8'))
  .replace('import { app, safeStorage, shell } from "electron";', 'const { app, safeStorage, shell } = globalThis.__authTestElectron;')
  .replace(/from "(\.\.?\/[^\"]+)"/g, (_, path) => 'from ' + JSON.stringify(pathToFileURL(resolve('electron/account', path)).href));
const { createDesktopAccountRuntime } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

const model = 'aporia-cloud-default';
const historyPath = '/v1/requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const auth = { error: { type: 'auth_error', message: 'UNAUTHORIZED' } };
let generation = 0;
let later, accepted;
const start = new Promise(resolve => { accepted = resolve; });
const release = new Promise(resolve => { later = resolve; });
let mode = 'race';
let e2eRejectedGeneration;
const posts = [];
globalThis.fetch = async (url, init = {}) => {
  const address = new URL(url);
  assert(address.hostname.endsWith('.example.invalid'));
  const path = address.pathname, headers = new Headers(init.headers), token = headers.get('Authorization');
  if (path === '/auth/refresh') {
    assert.equal(JSON.parse(init.body).refreshToken, 'fixture-refresh-' + generation);
    if (mode === 'refresh-failed') return Response.json({ error: 'REFRESH_UNAVAILABLE' }, { status: 503 });
    generation++;
    return Response.json({ accessToken: 'fixture-access-' + generation, refreshToken: 'fixture-refresh-' + generation,
      accessExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
  }
  if (path === historyPath) return token === 'Bearer fixture-access-1' ? Response.json(auth, { status: 401 }) : Response.json({ ok: true });
  if (path === '/v1/chat/completions') {
    posts.push({ token, key: headers.get('Idempotency-Key'), body: init.body });
    if (mode === 'race' && token === 'Bearer fixture-access-1') {
      accepted(); await release;
      return Response.json(auth, { status: 401 });
    }
    if (mode === 'ambiguous' || mode === 'refresh-failed') return Response.json({ error: { message: 'UNAUTHORIZED' } }, { status: 401 });
    if (mode === 'has-receipt') return Response.json(auth, { status: 401, headers: { 'x-aporia-request-id': 'known-request' } });
    if (mode === 'invalid') return Response.json(auth, { status: 401 });
    if (mode === 'end-to-end') {
      if (token === 'Bearer fixture-access-' + e2eRejectedGeneration) return Response.json({ error: { message: 'UNAUTHORIZED' } }, { status: 401 });
      return new Response('data: {"choices":[{"delta":{"content":"resumed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
    return Response.json({ ok: true });
  }
  assert.equal(token, 'Bearer fixture-access-' + generation);
  const responses = {
    '/me': { user: { id: 'fixture-user' }, session: { deviceId: 'fixture-device' }, identities: [] },
    '/models': [{ slug: model, enabled: true, freeTierAllowed: true }], '/quota/weekly': { remainingRatio: 1, availableRatio: 1 },
    '/capabilities': {}, '/v1/capabilities': { protocolVersion: 1, modelGateway: { idempotency: 'reject-duplicate-no-replay' }, models: [{ slug: model, available: true }] },
    '/usage/summary': {}, '/devices': [], '/invites': {},
  };
  assert(Object.hasOwn(responses, path), path);
  return Response.json(responses[path]);
};

const runtime = createDesktopAccountRuntime(options);
const send = () => runtime.fetchModelGateway('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model, stream: true }), signal: AbortSignal.timeout(5000) });
try {
  await writeFile(join(directory, 'aporiax-account-session.json'), JSON.stringify({ version: 2, endpointScope: endpoints.sessionScope,
    encryptedRefreshToken: Buffer.from('fixture-refresh-0').toString('base64') }));
  assert.equal((await runtime.getSnapshot()).status, 'authenticated');
  const modelRequest = send();
  await Promise.race([start, modelRequest.then(() => { throw Error('model did not exercise the stale token'); })]);
  try { assert.equal((await runtime.fetchModelGateway(historyPath)).status, 200); }
  finally { later(); }
  const retried = await modelRequest;
  assert.equal(retried.status, 200);
  await retried.json();
  assert.equal(generation, 2, 'the late 401 must not rotate the already renewed token');
  assert.deepEqual(posts.map(item => item.token), ['Bearer fixture-access-1', 'Bearer fixture-access-2']);
  assert.ok(posts[0].key && posts[0].key === posts[1].key, 'one logical request / same idempotency key');

  for (mode of ['ambiguous', 'has-receipt']) {
    const count = posts.length, before = generation;
    const response = await send(); assert.equal(response.status, 401);
    assert.ok((await response.json()).error, 'upstream can still read the original error body');
    assert.equal(posts.length, count + 1, 'refreshing an ambiguous 401 is not authority to replay inference');
    assert.equal(generation, before + 1);
    const recovery = cloudAuthRecoveryFor(response);
    assert.equal(recovery.refresh, 'ready');
    assert.equal(recovery.replayed, false);
    assert.doesNotThrow(recovery.assertSession);
    const previous = mode;
    mode = 'healthy';
    const nextTurn = await send();
    assert.equal(nextTurn.status, 200);
    await nextTurn.json();
    assert.equal(posts.at(-1).token, 'Bearer fixture-access-' + generation, 'next user turn needs no manual refresh');
    mode = previous;
  }
  mode = 'refresh-failed';
  const failedRefresh = await send();
  assert.equal(failedRefresh.status, 401);
  assert.equal(cloudAuthRecoveryFor(failedRefresh).refresh, 'failed');
  await failedRefresh.json();
  mode = 'expiry';
  const beforeExpiry = generation;
  Date.now = () => wallClock() + 14.75 * 60_000;
  const renewed = await send();
  assert.equal(renewed.status, 200);
  await renewed.json();
  assert.equal(generation, beforeExpiry + 1, 'almost-expired access token is refreshed before dispatch');
  assert.equal(posts.at(-1).token, 'Bearer fixture-access-' + generation);
  mode = 'invalid';
  const count = posts.length;
  const rejected = await send();
  assert.equal(rejected.status, 401);
  await rejected.json();
  assert.equal(generation, beforeExpiry + 2);
  assert.equal(posts.length, count + 2, 'a persistent rejection gets at most one safe retry');
  mode = 'end-to-end';
  e2eRejectedGeneration = generation;
  const config = { ...createAporiaCloudProvider(options.modelGatewayBaseUrl), authenticatedFetch: (path, init) => runtime.fetchModelGateway(path, init) };
  const stages = [], firstPost = posts.length;
  const infer = (scope, content) => withLoopRequestIdentity(createLoopRequestIdentity(scope), () => callModelProvider({
    provider: config, body: { model, messages: [{ role: 'user', content }] }, signal: AbortSignal.timeout(5000),
    onEvent: event => { if (event.type === 'response.cloud.auth') stages.push(event.stage); },
  }));
  assert.equal((await infer('auth-retry', 'first')).message.content, 'resumed');
  assert.equal(generation, e2eRejectedGeneration + 1);
  const [original, sameRequest] = posts.slice(firstPost);
  assert.equal(original.key, sameRequest.key);
  assert.equal(original.body, sameRequest.body);
  assert.deepEqual(stages, ['refreshing', 'reconciling', 'retrying', 'recovered']);
  assert.equal((await infer('auth-follow-up', 'next sentence')).message.content, 'resumed');
  assert.equal(posts.length, firstPost + 3);
  assert.equal(generation, e2eRejectedGeneration + 1);
  console.log('PASS Cloud auth: stale 401, shared and proactive refresh, ambiguous 401 updates next turn without replay, bounded explicit retry.');
} finally {
  later(); runtime.close(); globalThis.fetch = previousFetch; Date.now = wallClock;
  delete globalThis.__authTestElectron;
  await rm(directory, { recursive: true, force: true });
}

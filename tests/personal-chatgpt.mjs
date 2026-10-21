import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { createPersonalChatGPTService, CHATGPT_RESOURCE } from '../electron/personal-chatgpt/service.js';
import { compileProviderWire } from '../electron/runtime/native-provider-codec.js';
import { callModelProvider } from '../electron/runtime/provider-stream.js';
import { modelReasoningParameters } from '../shared/model-reasoning.js';
import { providerErrorCategory } from '../electron/runtime/provider-errors.js';
import { isTemporaryNetworkError } from '../electron/runtime/run-control.js';
import { completeLoopRequest } from '../electron/runtime/loop-recovery.js';

const root = await mkdtemp(join(tmpdir(), 'aporia-personal-chatgpt-'));
const keys = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...await exportJWK(keys.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
const cipherKey = randomBytes(32);
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', cipherKey, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
  decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', cipherKey, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'); },
};
const instances = [];
let sequence = 0;
function fixture(options = {}) {
  const f = { urls: [], requests: [], now: Date.now(), directory: join(root, `case-${sequence++}`), ...options };
  f.fetchImpl = async (url, init = {}) => {
    assert.equal(init.redirect, 'error', 'never follow credential-bearing redirects');
    const form = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
    f.requests.push({ url, form, init });
    if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
    if (url.endsWith('/oauth/revoke')) return new Response('', { status: f.revokeStatus || 200 });
    if (url.endsWith('/oauth/token')) {
      if (f.holdToken) await f.holdToken;
      if (f.tokenError) return Response.json({ error: f.tokenError }, { status: 400 });
      const auth = new URL(f.urls.at(-1));
      if (form.grant_type === 'authorization_code') {
        assert.equal(form.client_id, 'oaiapp_fixture');
        assert.equal(form.redirect_uri, auth.searchParams.get('redirect_uri'));
        assert.equal(form.resource, CHATGPT_RESOURCE);
        assert.equal(form.code_verifier.length >= 43, true);
      } else {
        assert.equal(form.grant_type, 'refresh_token');
        assert.equal(form.refresh_token, 'fixture-refresh');
        assert.equal(form.scope, undefined, 'retain grant on refresh');
      }
      const claims = { sub: 'subject-fixture', email: 'private@example.invalid', nonce: auth.searchParams.get('nonce'), ...f.claims };
      const token = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
        .setIssuer(f.issuer || 'https://auth.openai.com').setAudience(f.audience || 'oaiapp_fixture')
        .setIssuedAt(Math.floor(f.now / 1000)).setExpirationTime(Math.floor(f.now / 1000) + (f.expiry ?? 3600)).sign(keys.privateKey);
      return Response.json({ access_token: form.grant_type === 'refresh_token' ? 'fixture-access-refreshed' : 'fixture-access',
        refresh_token: form.grant_type === 'refresh_token' ? 'fixture-refresh-rotated' : 'fixture-refresh',
        expires_in: 3600, token_type: 'Bearer', scope: f.scopes ?? 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct',
        id_token: f.badSignature ? `${token.slice(0, -20)}invalid-signaturexxx` : token });
    }
    if (url === `${CHATGPT_RESOURCE}/models`) return Response.json({ models: [
      { slug: 'fixture-model', display_name: 'Personal fixture', visibility: 'list', input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'xhigh' }], default_reasoning_level: 'high' },
      { slug: 'hidden-model', visibility: 'hidden' }, { slug: 'unknown-effort', display_name: 'No fabricated capability', visibility: 'list' },
    ] });
    if (url === `${CHATGPT_RESOURCE}/responses`) {
      if (f.responseError) return Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'fixture' } }, { status: 429 });
      const body = JSON.parse(init.body);
      assert.equal(new Headers(init.headers).get('authorization'), f.now >= f.startedAt + 3600_000 ? 'Bearer fixture-access-refreshed' : 'Bearer fixture-access');
      assert.equal(new Headers(init.headers).has('x-aporia-task-id'), false);
      assert.equal(body.max_output_tokens, undefined);
      assert.equal(body.store, false); assert.equal(body.stream, true);
      const event = f.streamFailure ? { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_unavailable', message: 'fixture failure' } } }
        : f.truncated ? { type: 'response.output_text.delta', delta: 'partial' }
          : { type: 'response.completed', response: { output: f.toolResponse ? [{ type: 'function_call', call_id: 'call_local', name: 'read_file', namespace: 'aporiax', arguments: '{"path":"README.md"}' }]
            : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Personal plan fixture complete' }] }], usage: { input_tokens: 10, output_tokens: 4 } } };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected fixture endpoint: ${url}`);
  };
  f.startedAt = f.now;
  f.service = createPersonalChatGPTService({ directory: f.directory, safeStorage: f.safeStorage || safeStorage,
    fetchImpl: f.fetchImpl, openExternal: async url => { f.urls.push(url); if (f.browserFail) throw new Error('browser'); }, now: () => f.now,
    ...(f.enabled === false ? { enabled: false } : {}), ...(f.loginTimeoutMs ? { loginTimeoutMs: f.loginTimeoutMs } : {}) });
  instances.push(f.service);
  f.callbackUrl = extra => {
    const auth = new URL(f.urls.at(-1)), callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'fixture-code');
    callback.searchParams.set('client_id', 'oaiapp_fixture');
    for (const [key, value] of Object.entries(extra || {})) callback.searchParams.set(key, value);
    return callback;
  };
  f.connect = async extra => { await f.service.startLogin(); const response = await fetch(f.callbackUrl(extra)); await response.text(); return f.service.status(); };
  return f;
}
try {
  const f = fixture();
  assert.equal((await f.service.status()).status, 'disconnected');
  await f.service.startLogin();
  const auth = new URL(f.urls[0]);
  assert.equal(auth.origin, 'https://auth.openai.com');
  assert.equal(auth.pathname, '/api/accounts/authorize');
  assert.equal(auth.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(auth.searchParams.get('agent_name_hint'), 'AporiaX');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(new URL(auth.searchParams.get('redirect_uri')).hostname, '127.0.0.1');
  assert.match(auth.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  const badState = await fetch(f.callbackUrl({ state: 'wrong-state' }));
  assert.equal(badState.status, 400); await badState.text();
  assert.equal(f.requests.length, 0, 'bad state never exchanges code');
  const ok = await fetch(f.callbackUrl()); await ok.text();
  assert.equal(ok.status, 200);
  assert.equal((await f.service.status()).planUsageGranted, true);
  const disk = await readFile(join(f.directory, 'session.enc'), 'utf8');
  assert.doesNotMatch(disk, /fixture-access|fixture-refresh|private@example|subject-fixture|eyJ/);
  assert.doesNotMatch(JSON.stringify(await f.service.status()), /fixture-access|fixture-refresh|clientId|idToken|eyJ/);
  const restarted = createPersonalChatGPTService({ directory: f.directory, safeStorage, fetchImpl: f.fetchImpl, openExternal: async () => {}, now: () => f.now });
  instances.push(restarted);
  assert.equal((await restarted.status()).status, 'connected', 'OS-encrypted local session survives application restart');
  assert.equal((await restarted.provider()).models[0].id, 'fixture-model', 'reload current account catalog after restart');
  const provider = await f.service.resolveProvider();
  assert.equal(provider.apiKey, undefined); assert.equal(provider.billing, 'personal-chatgpt-plan');
  assert.equal(provider.models.length, 2); assert.deepEqual(provider.models[0].supportedEfforts, ['low', 'high', 'xhigh']);
  assert.equal(provider.models[1].supportsThinking, false);
  const body = { model: 'fixture-model', max_tokens: 8192, temperature: 1, messages: [{ role: 'system', content: 'Local harness rules' }, { role: 'user', content: 'Hi' }],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'Read local file', parameters: { type: 'object', properties: {} } } }], reasoning_effort: 'xhigh' };
  const wire = compileProviderWire(provider, body);
  assert.equal(wire.url, `${CHATGPT_RESOURCE}/responses`);
  assert.equal(wire.body.input[0].role, 'developer');
  assert.equal(wire.body.tools[0].type, 'namespace');
  assert.equal(wire.body.tools[0].name, 'aporiax');
  assert.equal(wire.body.temperature, undefined); assert.equal(wire.body.max_output_tokens, undefined);
  assert.equal(wire.body.reasoning.effort, 'xhigh');
  assert.deepEqual(modelReasoningParameters({ ...provider, ...provider.models[0] }, { thinking: true, effort: 'xhigh' }), { reasoning_effort: 'xhigh' });
  let answer = await callModelProvider({ provider, body });
  assert.match(answer.message.content, /fixture complete/);
  assert.deepEqual((await f.service.status()).verifiedModelIds, ['fixture-model']);
  assert.equal(answer.cloudQuotaSnapshot, undefined);
  f.toolResponse = true;
  answer = await callModelProvider({ provider, body });
  assert.equal(answer.message.tool_calls[0].function.name, 'read_file');
  assert.equal(answer.message.aporiaNative.items[0].namespace, 'aporiax');
  const continuation = { ...body, messages: [...body.messages, { role: 'assistant', ...answer.message }, { role: 'tool', tool_call_id: 'call_local', content: 'local file text' }] };
  assert.equal(compileProviderWire(provider, continuation).body.input.at(-1).type, 'function_call_output');
  assert.throws(() => compileProviderWire({ ...provider, personalAccountBinding: 'other-account' }, continuation), /PROVIDER_NATIVE_STATE_MISMATCH/);
  assert.throws(() => compileProviderWire({ ...provider, baseUrl: 'https://evil.invalid' }, body), /PERSONAL_CHATGPT_ROUTE_INVALID/);
  f.toolResponse = false;
  f.now += 3600_000;
  await Promise.all([provider.personalFetch('/models'), provider.personalFetch('/models'), provider.personalFetch('/models')].map(async promise => { const response = await promise; await response.text(); }));
  const refreshes = f.requests.filter(r => r.form?.grant_type === 'refresh_token');
  assert.equal(refreshes.length, 1, 'parallel requests share one rotating-token refresh');
  const encrypted = JSON.parse(await readFile(join(f.directory, 'session.enc'), 'utf8'));
  const stored = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted.ciphertext, 'base64')));
  assert.equal(stored.refreshToken, 'fixture-refresh-rotated');
  for (const mode of ['responseError', 'streamFailure', 'truncated']) {
    f[mode] = true;
    const before = f.requests.filter(r => r.url.endsWith('/responses')).length;
    await assert.rejects(callModelProvider({ provider, body }), error => {
      assert.equal(error.retryable, false);
      assert.equal(error.noAutomaticRetry, true);
      assert.equal(isTemporaryNetworkError(error), false, 'outer network suspension must not replay personal inference');
      if (mode !== 'truncated') assert.equal(providerErrorCategory(error), 'quota');
      return true;
    });
    assert.equal(f.requests.filter(r => r.url.endsWith('/responses')).length, before + 1, 'no automatic personal-plan request replay');
    f[mode] = false;
  }
  let outerCalls = 0;
  await assert.rejects(completeLoopRequest({ conversation: [...body.messages], contextCheckpoints: [], getBody: () => body,
    complete: async () => { outerCalls++; throw Object.assign(new Error('fixture no replay'), { code: 'PROVIDER_FINISH_LENGTH', streamComplete: true, noAutomaticRetry: true }); } }), /fixture no replay/);
  assert.equal(outerCalls, 1, 'outer repair loop also honors personal no-replay boundary');
  await assert.rejects(provider.personalFetch('https://evil.invalid'), /不支持/);
  assert.equal((await f.service.signOut()).status, 'disconnected');
  const afterLogout = JSON.parse(safeStorage.decryptString(Buffer.from(JSON.parse(await readFile(join(f.directory, 'session.enc'), 'utf8')).ciphertext, 'base64')));
  assert.equal(afterLogout.accessToken, undefined); assert.equal(afterLogout.refreshToken, undefined); assert.equal(afterLogout.idToken, undefined);
  await assert.rejects(provider.personalFetch('/responses', {}), /先连接/);
  await f.service.startLogin();
  const again = new URL(f.urls.at(-1));
  assert.equal(again.searchParams.get('client_id'), 'oaiapp_fixture');
  assert.equal(again.searchParams.has('id_token_hint'), false, 'no ID token retained after sign-out');
  assert.equal(again.searchParams.has('agent_name_hint'), false);
  assert.equal(again.searchParams.get('ext_agent_host_id'), auth.searchParams.get('ext_agent_host_id'));
  await f.service.cancel();
  for (const options of [{ badSignature: true }, { claims: { nonce: 'wrong' } }, { issuer: 'https://evil.invalid' }, { audience: 'other-client' }, { expiry: -60 }, { scopes: 'openid profile email' }]) {
    const bad = fixture(options); const status = await bad.connect();
    assert.equal(status.status, 'disconnected'); assert(status.lastError);
    assert.equal(status.planUsageGranted, false);
    await assert.rejects(readFile(join(bad.directory, 'session.enc')), { code: 'ENOENT' });
  }
  const denied = fixture(); assert.equal((await denied.connect({ error: 'access_denied' })).status, 'disconnected');
  assert.equal(denied.requests.length, 0);
  const secure = fixture({ safeStorage: { isEncryptionAvailable: () => false } });
  await assert.rejects(secure.service.startLogin(), /安全凭据/); assert.equal(secure.urls.length, 0);
  const disabled = fixture({ enabled: false });
  assert.equal((await disabled.service.status()).available, false); await assert.rejects(disabled.service.startLogin(), /本地开发版/);
  const corrupted = fixture(); await mkdir(corrupted.directory, { recursive: true }); await writeFile(join(corrupted.directory, 'session.enc'), 'invalid fixture');
  assert.equal((await corrupted.service.provider()).disabled, true, 'corrupt personal session does not reject the whole provider list');
  await assert.rejects(corrupted.service.status(), /安全读取/);
  const browser = fixture({ browserFail: true });
  await assert.rejects(browser.service.startLogin(), /浏览器/); assert.equal((await browser.service.status()).status, 'disconnected');
  const timeout = fixture({ loginTimeoutMs: 25 });
  await timeout.service.startLogin(); await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal((await timeout.service.status()).status, 'disconnected'); assert.match((await timeout.service.status()).lastError, /超时/);
  const notRevoked = fixture({ revokeStatus: 503 }); await notRevoked.connect();
  assert.match((await notRevoked.service.signOut()).lastError, /未确认远端撤销/);
  const invalidRefresh = fixture(); await invalidRefresh.connect(); invalidRefresh.now += 3600_000; invalidRefresh.tokenError = 'invalid_grant';
  await assert.rejects(invalidRefresh.service.resolveProvider(), /过期/);
  assert.equal((await invalidRefresh.service.status()).status, 'disconnected');
  let release;
  const canceled = fixture({ holdToken: new Promise(resolve => { release = resolve; }) });
  await canceled.service.startLogin();
  const callback = fetch(canceled.callbackUrl()).catch(() => null);
  while (!canceled.requests.some(r => r.form?.grant_type === 'authorization_code')) await new Promise(resolve => setTimeout(resolve, 5));
  await canceled.service.cancel(); release(); await callback;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await canceled.service.status()).status, 'disconnected');
  console.log('PASS personal ChatGPT: PKCE/state/OIDC, OS-encrypted storage, scope gating, local-only routing, real catalog normalization, tool continuation, account isolation, serialized refresh, cancel/expiry/logout, quota/incomplete no replay. No real credentials or inference used.');
} finally {
  for (const service of instances) service.dispose();
  await rm(root, { recursive: true, force: true });
}

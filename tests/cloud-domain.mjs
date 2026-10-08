import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { get } from 'node:http';
import { loadCloudEndpoints, sessionMatchesEndpoints } from '../electron/account/cloud-endpoints.js';
import { createAporiaCloudProvider } from '../electron/provider-config.js';
import { DEFAULT_APORIAX_ACCOUNT_WEB_URL, DEFAULT_APORIAX_CLOUD_API_URL, DEFAULT_APORIAX_MODEL_GATEWAY_URL } from '../electron/account/desktop-account-core.js';

const origin = 'https://aporiax.cloud';
const manifest = JSON.parse(await readFile('config/cloud-endpoints.json', 'utf8'));
assert.deepEqual(manifest, { version: 1, accountWebUrl: origin, accountApiUrl: `${origin}/api`, modelGatewayUrl: `${origin}/gateway` });
assert.deepEqual([DEFAULT_APORIAX_ACCOUNT_WEB_URL, DEFAULT_APORIAX_CLOUD_API_URL, DEFAULT_APORIAX_MODEL_GATEWAY_URL], [origin, `${origin}/api`, `${origin}/gateway`]);
assert.equal(createAporiaCloudProvider().baseUrl, `${origin}/gateway`);
const endpoints = loadCloudEndpoints({}, {});
assert(endpoints.configured); assert.equal(endpoints.legacy, false);
const oldEndpoints = loadCloudEndpoints({ webBaseUrl: 'https://101.43.44.160', apiBaseUrl: 'https://101.43.44.160/api', modelGatewayBaseUrl: 'https://101.43.44.160/gateway' }, {});
assert(!sessionMatchesEndpoints({ endpointScope: oldEndpoints.sessionScope }, endpoints));
assert(!sessionMatchesEndpoints({}, endpoints), 'unscoped legacy credentials cannot be forwarded to the new domain');
const temp = await mkdtemp(join(tmpdir(), 'aporia-cloud-domain-'));
const originalFetch = globalThis.fetch;
const sent = [], opened = [];
let authorization, callbackDone, runtime, restarted;
const fakeRefresh = 'synthetic-refresh', fakeAccess = 'synthetic-access';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
globalThis.__domainTestElectron = {
  app: { getPath: () => temp, getVersion: () => '1.0.0-rc.4' },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
  shell: { openExternal: async value => {
    const url = new URL(value); opened.push(url);
    assert.equal(url.origin, origin);
    if (url.pathname === '/account') return;
    authorization = url;
    assert.equal(url.searchParams.get('desktop_authorize'), '1');
    const callback = new URL(url.searchParams.get('redirect_uri'));
    assert.equal(callback.hostname, '127.0.0.1'); assert.equal(callback.pathname, '/callback');
    callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('code', 'a'.repeat(43));
    callbackDone = new Promise((done, reject) => {
      get(callback, response => { response.resume(); response.on('end', () => { try { assert.equal(response.statusCode, 200); done(); } catch (error) { reject(error); } }); }).on('error', reject);
    });
  } },
};
try {
  assert.equal(loadCloudEndpoints({ endpointManifest: join(temp, 'missing') }, {}).configured, false);
  let source = await readFile('electron/account/desktop-account-runtime.js', 'utf8');
  source = source.replace('import { app, safeStorage, shell } from "electron";', 'const { app, safeStorage, shell } = globalThis.__domainTestElectron;')
    .replace(/from "(\.\.?\/[^\"]+)"/g, (_, path) => 'from ' + JSON.stringify(pathToFileURL(resolve('electron/account', path)).href));
  const { createDesktopAccountRuntime } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const sessionPath = join(temp, 'aporiax-account-session.json');
  await writeFile(sessionPath, JSON.stringify({ endpointScope: oldEndpoints.sessionScope, encryptedRefreshToken: Buffer.from('old-scope-must-not-send').toString('base64') }));
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url); assert.equal(target.origin, origin, 'all account and gateway requests use the new domain');
    sent.push({ path: target.pathname, method: init.method || 'GET' });
    const body = init.body ? JSON.parse(init.body) : {};
    if (target.pathname === '/api/beta/status') return json({ enabled: true });
    if (target.pathname === '/api/auth/desktop/token') {
      assert.equal(createHash('sha256').update(body.codeVerifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
      assert.equal(body.redirectUri, authorization.searchParams.get('redirect_uri'));
      return json({ accessToken: fakeAccess, refreshToken: fakeRefresh });
    }
    if (target.pathname === '/api/auth/refresh') { assert.equal(body.refreshToken, fakeRefresh); return json({ accessToken: fakeAccess, refreshToken: fakeRefresh }); }
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${fakeAccess}`);
    if (target.pathname === '/api/me') return json({ user: { id: 'fixture', displayName: 'Fixture' }, identities: [], session: { deviceId: 'device' } });
    if (target.pathname === '/api/models') return json([{ slug: 'aporia-cloud-default', enabled: true, freeTierAllowed: true }]);
    if (target.pathname === '/api/quota/weekly') return json({ remainingRatio: 1 });
    if (target.pathname === '/api/capabilities') return json({});
    if (target.pathname === '/api/devices') return json([{ id: 'device', name: 'Fixture' }]);
    if (target.pathname === '/api/usage/summary') return json({ requestCount: 0 });
    if (target.pathname === '/gateway/v1/capabilities') return json({ protocolVersion: 1, models: [{ slug: 'aporia-cloud-default', available: true }] });
    if (target.pathname === '/gateway/v1/chat/completions') return json({ choices: [{ message: { role: 'assistant', content: 'MOCK_ONLY' } }] });
    if (target.pathname === '/api/auth/logout') return json({ ok: true });
    throw new Error(`Unexpected fixture request: ${target.pathname}`);
  };
  runtime = createDesktopAccountRuntime();
  assert.equal((await runtime.getSnapshot()).status, 'anonymous'); assert.equal(sent.length, 0, 'old credentials never sent or deleted');
  assert.match(await readFile(sessionPath, 'utf8'), new RegExp(oldEndpoints.sessionScope));
  await runtime.openAccountCenter(); assert.equal(opened[0].href, `${origin}/account`);
  assert.equal((await runtime.startBrowserLogin()).status, 'authenticated'); await callbackDone;
  assert.equal(JSON.parse(await readFile(sessionPath, 'utf8')).endpointScope, endpoints.sessionScope);
  const model = await runtime.fetchModelGateway('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'aporia-cloud-default', messages: [{ role: 'user', content: 'synthetic fixture' }] }) });
  assert.equal((await model.json()).choices[0].message.content, 'MOCK_ONLY');
  restarted = createDesktopAccountRuntime();
  assert.equal((await restarted.getSnapshot()).status, 'authenticated');
  assert(sent.some(item => item.path === '/api/auth/refresh'));
  await restarted.signOut();
  const update = await readFile('electron/app-update.js', 'utf8');
  assert.match(update, /endpoints\.accountWebUrl \+ "\/downloads\/latest\.yml"/);
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert(pkg.build.files.includes('config/cloud-endpoints.json') && pkg.build.files.includes('shared/**/*'));
  console.log('PASS new domain: manifest/defaults, scoped sessions, actual loopback + PKCE, token exchange, account refresh, model transport, account center and mirror configuration (synthetic credentials; zero live model requests)');
} finally {
  runtime?.close(); restarted?.close(); globalThis.fetch = originalFetch; delete globalThis.__domainTestElectron;
  await rm(temp, { recursive: true, force: true });
}

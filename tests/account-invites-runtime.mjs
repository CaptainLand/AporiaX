import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCloudEndpoints } from '../electron/account/cloud-endpoints.js';

const parent = resolve('.tmp/account-invite-tests');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'runtime-'));
globalThis.__inviteElectron = { app: { getPath: () => directory, getVersion: () => '1.0.6' },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() }, shell: {} };
let source = await readFile('electron/account/desktop-account-runtime.js', 'utf8');
source = source.replace('import { app, safeStorage, shell } from "electron";', 'const {app,safeStorage,shell} = globalThis.__inviteElectron;')
  .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, quote, path) => 'from ' + JSON.stringify(pathToFileURL(resolve('electron/account', path)).href));
const { createDesktopAccountRuntime } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const options = { apiBaseUrl: 'https://api.example.invalid', webBaseUrl: 'https://web.example.invalid', modelGatewayBaseUrl: 'https://gateway.example.invalid', endpointManifest: join(directory, 'missing') };
const endpoints = loadCloudEndpoints(options);
await writeFile(join(directory, 'aporiax-account-session.json'), JSON.stringify({ version: 2, endpointScope: endpoints.sessionScope,
  encryptedRefreshToken: Buffer.from('test-refresh-only').toString('base64') }));
const originalFetch = globalThis.fetch;
let inviteFailure = false, pending = null, inviteStarted;
let invites = { inviteCode: 'ABC123DEF0', successfulInvites: 0, nextRewardPercent: 100, rewardsExhausted: false };
let inviteRequests = 0;
globalThis.fetch = async (url, init) => {
  const address = new URL(url);
  assert.ok(address.hostname.endsWith('.example.invalid'), 'no real account requests');
  if (address.pathname === '/auth/refresh') return Response.json({ accessToken: 'test-access-only', refreshToken: 'test-refresh-only' });
  if (address.pathname === '/auth/logout') return Response.json({ ok: true });
  assert.equal(init.headers.get('Authorization'), 'Bearer test-access-only');
  if (address.pathname === '/invites') {
    inviteRequests++;
    assert.equal(init.method, 'GET');
    assert.ok(init.signal);
    inviteStarted?.();
    if (pending) await pending;
    return Response.json(inviteFailure ? { error: 'test-failure' } : invites, { status: inviteFailure ? 503 : 200 });
  }
  const responses = {
    '/me': { user: { id: 'fixture', displayName: 'Fixture' }, identities: [] },
    '/models': [], '/quota/weekly': { remainingRatio: .7 }, '/capabilities': {},
    '/v1/capabilities': { protocolVersion: 1, models: [] }, '/usage/summary': {}, '/devices': [],
  };
  assert.ok(Object.hasOwn(responses, address.pathname), address.pathname);
  return Response.json(responses[address.pathname]);
};
const runtime = createDesktopAccountRuntime(options);
try {
  let snapshot = await runtime.getSnapshot();
  assert.equal(snapshot.status, 'authenticated');
  assert.deepEqual(snapshot.invites, invites);
  invites = { ...invites, successfulInvites: 2, nextRewardPercent: 30 };
  snapshot = await runtime.refresh();
  assert.deepEqual(snapshot.invites, invites, 'refresh follows the server reward stage');
  inviteFailure = true;
  snapshot = await runtime.refresh();
  assert.equal(snapshot.status, 'authenticated', 'optional invite outage must not sign out the account');
  assert.equal(snapshot.quota.remainingRatio, .7);
  assert.equal(snapshot.invites, null, 'do not present stale rewards as current after an outage');
  inviteFailure = false;
  invites = { ...invites, successfulInvites: 3, nextRewardPercent: null, rewardsExhausted: true };
  assert.deepEqual((await runtime.refresh()).invites, invites);
  let release;
  pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { inviteStarted = resolve; });
  const refresh = runtime.refresh();
  const rejected = assert.rejects(refresh, /DESKTOP_ACCOUNT_CHANGED/);
  await started;
  assert.equal((await runtime.signOut()).invites, null);
  release();
  await rejected;
  assert.equal((await runtime.getSnapshot()).status, 'anonymous');
  assert.equal(inviteRequests, 5);
  console.log('PASS account invitations: authenticated API, current rewards, optional failure, exhaustion, sign-out and stale response guard.');
} finally {
  await runtime.close();
  globalThis.fetch = originalFetch;
  delete globalThis.__inviteElectron;
  const within = relative(parent, resolve(directory));
  assert.ok(within.startsWith('runtime-') && !within.includes(sep));
  await rm(directory, { recursive: true, force: true });
}

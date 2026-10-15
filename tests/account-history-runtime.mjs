import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'aporia-history-'));
const originalFetch = globalThis.fetch;
globalThis.__historyElectron = { app: { getPath: () => directory, getVersion: () => '1.0.0' }, safeStorage: {}, shell: {} };
let source = await readFile('electron/account/desktop-account-runtime.js', 'utf8');
source = source.replace('import { app, safeStorage, shell } from "electron";', 'const { app, safeStorage, shell } = globalThis.__historyElectron;');
source = source.replace('let currentSnapshot = emptySnapshot();', "let currentSnapshot = {status:'authenticated',profile:{id:'fixture'}};");
source = source.replace('let accessToken = "";', 'let accessToken = "fixture-token";');
source = source.replace(/from "(\.\.?\/[^\"]+)"/g, (_, p) => 'from ' + JSON.stringify(pathToFileURL(resolve('electron/account', p)).href));
source = source.replace(/from '(\.\.?\/[^']+)'/g, (_, p) => 'from ' + JSON.stringify(pathToFileURL(resolve('electron/account', p)).href));
const { createDesktopAccountRuntime } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
let requests = [], responseStatus = 200, wait = null;
globalThis.fetch = async (url, init) => {
  requests.push({ url, init });
  if (url.includes('/auth/logout')) return Response.json({ ok: true });
  if (wait) await wait;
  return Response.json(responseStatus === 200 ? { items: [{ requestId: 'safe', startedAt: '2026-10-14T00:00:00Z', billingStatus: 'settled', tokens: { input: 2, output: 1 }, prompt: 'PRIVATE' }], nextCursor: null, sampledAt: '2026-10-14T01:00:00Z' } : { error: 'PRIVATE_API_KEY=secret' }, { status: responseStatus });
};
try {
  const runtime = createDesktopAccountRuntime({ webBaseUrl: 'https://web.example.invalid', apiBaseUrl: 'https://api.example.invalid', modelGatewayBaseUrl: 'https://gateway.example.invalid', endpointManifest: join(directory, 'missing') });
  await assert.rejects(runtime.getRequestHistory({ accountId: 'other' }), /SESSION_CHANGED/);
  assert.equal(requests.length, 0);
  const result = await runtime.getRequestHistory({ accountId: 'fixture' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.equal(requests[0].url, 'https://api.example.invalid/usage/requests?days=all&status=all&limit=100');
  responseStatus = 404; await assert.rejects(runtime.getRequestHistory({ accountId: 'fixture' }), /^Error: ACCOUNT_HISTORY_UNAVAILABLE$/);
  responseStatus = 500; await assert.rejects(runtime.getRequestHistory({ accountId: 'fixture' }), /^Error: ACCOUNT_HISTORY_LOAD_FAILED$/);
  responseStatus = 200;
  let release; wait = new Promise(resolve => { release = resolve; });
  const pending = runtime.getRequestHistory({ accountId: 'fixture' });
  const rejection = assert.rejects(pending, /SESSION_CHANGED/);
  await runtime.signOut(); release(); await rejection;
  await runtime.close();
  console.log('PASS fixed read-only endpoint, account ownership guard, sanitized results/errors, unsupported API and logout during request.');
} finally { globalThis.fetch = originalFetch; delete globalThis.__historyElectron; await rm(directory, { recursive: true, force: true }); }

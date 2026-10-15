import assert from 'node:assert/strict';
import { _electron, chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { listPackage, extractFile } from '@electron/asar';

const origin = 'https://101.43.44.160';
const output = resolve('release/v1.0.0-preview.2.beta.1');
const archive = join(output, 'win-unpacked/resources/app.asar');
const pkg = JSON.parse(extractFile(archive, 'package.json'));
assert.equal(pkg.version, '1.0.0-preview.2.beta.1');
assert.equal(pkg.main, 'electron/main-friends-beta.js');
const endpoints = JSON.parse(extractFile(archive, 'config/cloud-endpoints.json'));
assert.deepEqual(endpoints, { version: 1, accountWebUrl: origin, accountApiUrl: origin + '/api', modelGatewayUrl: origin + '/gateway' });
const entries = listPackage(archive);
assert.ok(!entries.some(p => /cloud-private-preview\.json|\.ssh[\\/]|\.env($|\.)|cloud_preview_ed25519|aporiax-account-session\.json/i.test(p)), 'No credentials or private profiles in package');
for (const path of ['electron/main-friends-beta.js', 'electron/app-update.js', 'electron/account/desktop-account-runtime.js', 'electron/account/register-desktop-account-ipc.js']) {
  assert.deepEqual(extractFile(archive, join(...path.split('/'))), await readFile(resolve(path)), path + ' must match source');
}
console.log('PASS package: beta version, independent entry, HTTPS endpoints, current runtime and no private configuration');
const profile = await mkdtemp(resolve('.tmp/friends-beta-qa-'));
const data = join(profile, 'data'); await mkdir(data);
const ssh = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-i', join(homedir(), '.ssh/aporiax_cloud_preview_ed25519'), 'ubuntu@101.43.44.160'];
const command = 'cd /srv/aporiax-cloud-preview && sudo -n bash deploy/friends-beta/compose.sh exec -T api node -';
const input = ' < scripts/friends-beta-browser-fixture.cjs';
let fixture, browser, desktop;
try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext(); // Real certificate validation; no ignoreHTTPSErrors.
  const web = await context.newPage(); const errors = [];
  web.on('pageerror', e => errors.push(e.message));
  await web.addInitScript(() => localStorage.setItem('aporia-language', 'zh'));
  assert.equal((await web.goto(origin)).status(), 200);
  await web.locator('#download').scrollIntoViewIfNeeded();
  await web.getByText('此页面下载独立 Windows 内测版', { exact: false }).waitFor();
  assert.equal((await context.request.get(origin + '/guide/')).status(), 200);
  for (const path of ['/api/credits/dev-grant', '/api/admin', '/gateway/health', '/.env', '/api/unknown']) {
    assert.equal((await context.request.get(origin + path)).status(), 404, path);
  }
  assert.equal((await context.request.get(origin + '/api/me')).status(), 401);
  await web.goto(origin + '/account'); await web.locator('.account-gate').waitFor();
  console.log('PASS public Web: trusted HTTPS, beta copy, guide, anonymous guard and denied internal routes');
  fixture = JSON.parse(execFileSync('ssh', [...ssh, command + input], { encoding: 'utf8', windowsHide: true, timeout: 20000 }));
  // Only a random example.invalid fixture OTP is seeded over SSH. No mail is sent,
  // no fixed OTP mode is enabled, and normal registration/session logic is used.
  const verified = await context.request.post(origin + '/api/auth/email/verify', { data: { email: fixture.email, code: fixture.code, clientType: 'web' } });
  assert.equal(verified.status(), 200, 'Fixture registration must use normal API');
  const cookie = (await context.cookies()).find(c => c.name === 'aporia_refresh');
  assert.ok(cookie?.secure && cookie.httpOnly);
  assert.equal(cookie.path, '/api/auth'); assert.equal(cookie.sameSite, 'Lax');
  await web.reload(); await web.locator('.account-sidebar').waitFor({ timeout: 20000 });
  await web.reload(); await web.locator('.account-sidebar').waitFor({ timeout: 20000 });
  console.log('PASS registration and Web refresh: real API, secure HttpOnly cookie, account survives page reload');
  const env = { ...process.env, APPDATA: join(profile, 'roaming'), LOCALAPPDATA: join(profile, 'local') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'APORIAX_ACCOUNT_WEB_URL', 'APORIAX_CLOUD_API_URL', 'APORIAX_MODEL_GATEWAY_URL']) delete env[key];
  const launch = () => _electron.launch({ executablePath: join(output, 'win-unpacked/AporiaX Beta.exe'), args: ['--user-data-dir=' + data], env, timeout: 30000 });
  desktop = await launch();
  const info = await desktop.evaluate(({ app, shell }) => {
    shell.openExternal = async url => { globalThis.__betaOpenedUrl = url; };
    return { packaged: app.isPackaged, version: app.getVersion(), data: app.getPath('userData'), beta: process.env.APORIAX_FRIENDS_BETA };
  });
  assert.equal(info.packaged, true); assert.equal(info.data, data); assert.equal(info.beta, '1');
  const page = await desktop.firstWindow();
  await page.locator('.ax-welcome__enter').click({ timeout: 30000 });
  await page.locator('.local-account-signin').click();
  let authUrl;
  for (let i = 0; i < 60; i++) { authUrl = await desktop.evaluate(() => globalThis.__betaOpenedUrl); if (authUrl) break; await new Promise(r => setTimeout(r, 250)); }
  assert.ok(authUrl); assert.equal(new URL(authUrl).origin, origin);
  await web.goto(authUrl); await web.locator('.desktop-auth-account strong').waitFor();
  await web.getByRole('button', { name: '确认并连接', exact: true }).click();
  await page.locator('.local-account-profile').waitFor({ timeout: 30000 });
  const snapshot = await page.evaluate(async () => { const s = await window.desktop.account.get(); return { status: s.status, gateway: s.gatewayStatus, remote: s.capabilities.remote.supported }; });
  assert.deepEqual(snapshot, { status: 'authenticated', gateway: 'verified', remote: false });
  const center = page.locator('.local-account-web');
  if (!await center.isVisible()) await page.locator('.local-account-profile').click();
  await center.click();
  assert.equal(await desktop.evaluate(() => globalThis.__betaOpenedUrl), origin + '/account');
  await web.goto(origin + '/account'); await web.locator('.account-sidebar').waitFor();
  await page.screenshot({ path: join(profile, 'desktop-signed-in.png') });
  await web.screenshot({ path: join(profile, 'web-account.png') });
  console.log('PASS packaged Desktop -> browser launch URL -> real authorization UI/PKCE -> Cloud -> account center (no SSH tunnel)');
  if (process.argv.includes('--model')) {
    const model = await desktop.evaluate(async ({ app }) => {
      // Playwright evaluation has no dynamic-import callback. Use Node's main
      // context loader to reach the existing packaged module, not a second runtime.
      const { pathToFileURL } = process.getBuiltinModule('node:url');
      const { randomUUID } = process.getBuiltinModule('node:crypto');
      const { runInThisContext, constants } = process.getBuiltinModule('node:vm');
      const url = pathToFileURL(app.getAppPath() + '/electron/account/register-desktop-account-ipc.js').href;
      const { getDesktopAccountRuntime } = await runInThisContext('import(' + JSON.stringify(url) + ')', { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
      const runtime = getDesktopAccountRuntime();
      const response = await runtime.fetchModelGateway('/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ model: 'aporia-cloud-default', messages: [{ role: 'user', content: 'Reply exactly OK. Do not use tools.' }], max_tokens: 32, stream: true, stream_options: { include_usage: true } }),
        signal: AbortSignal.timeout(90000),
      });
      const body = await response.text();
      const chunks = body.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
      return { status: response.status, done: body.includes('data: [DONE]'), content: chunks.map(c => c.choices?.[0]?.delta?.content || '').join(''), error: chunks.find(c => c.error)?.error, usage: chunks.findLast(c => c.usage)?.usage };
    });
    assert.equal(model.status, 200); assert.equal(model.done, true); assert.ok(!model.error); assert.ok(model.content.trim());
    console.log('PASS live model via packaged account runtime:', JSON.stringify(model));
  }
  await desktop.close(); desktop = await launch();
  const reloaded = await desktop.firstWindow();
  // The desktop intentionally presents its welcome screen each launch.
  await reloaded.locator('.ax-welcome__enter').click({ timeout: 30000 });
  await reloaded.locator('.local-account-profile').waitFor({ timeout: 30000 });
  assert.equal(await reloaded.evaluate(async () => (await window.desktop.account.get()).status), 'authenticated');
  await reloaded.evaluate(() => window.desktop.account.signOut());
  assert.equal(await reloaded.evaluate(async () => (await window.desktop.account.get()).status), 'anonymous');
  assert.equal((await context.request.post(origin + '/api/auth/logout', { data: {} })).status(), 200);
  await web.reload(); await web.locator('.account-gate').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS encrypted Desktop session survives restart, Desktop/Web logout and zero uncaught Web errors');
  console.log('QA screenshots: ' + profile);
} finally {
  await desktop?.close(); await browser?.close();
  if (fixture) execFileSync('ssh', [...ssh, command + ' cleanup ' + fixture.email + input], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 20000 });
}

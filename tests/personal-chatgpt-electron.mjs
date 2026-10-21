import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';

const evidence = resolve('.tmp/personal-chatgpt-qa');
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(evidence, 'profile-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
for (const key of Object.keys(env)) if (/^(?:APORIAX_|PORTABLE_|OPENAI_|CODEX_)/.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DEEPSEEK_API_KEY'].includes(key)) delete env[key];
let application;
try {
  application = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('.'), `--user-data-dir=${profile}`, '--disable-gpu'], env, timeout: 30000 });
  assert.equal(resolve(await application.evaluate(({ app }) => app.getPath('userData'))), profile);
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.desktop?.personalChatGPT));
  await page.evaluate(() => { localStorage.setItem('aporiax.language.v1', 'zh-CN'); localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ welcomeDismissed: true })); });
  await page.reload();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  const initial = await page.evaluate(() => window.desktop.personalChatGPT.status());
  assert.equal(initial.available, true); assert.equal(initial.status, 'disconnected');
  const providers = await page.evaluate(() => window.desktop.providers.list());
  const personal = providers.find(provider => provider.id === 'chatgpt-personal');
  assert.equal(personal.hasApiKey, false); assert.equal(personal.managed, true); assert.equal(personal.disabled, true);
  await application.evaluate(({ shell }) => {
    globalThis.personalOpenedUrls = [];
    shell.openExternal = async url => { globalThis.personalOpenedUrls.push(url); };
  });
  await page.getByRole('button', { name: '打开 AporiaX 设置', exact: true }).click();
  await page.getByRole('button', { name: '模型与 API', exact: true }).click();
  await page.getByRole('region', { name: '个人 ChatGPT 账号', exact: true }).waitFor();
  const panel = page.locator('.personal-chatgpt-panel');
  assert.equal(await panel.locator('input[type=password]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '添加 Provider', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await page.getByRole('button', { name: '取消连接', exact: true }).waitFor();
  const auth = await application.evaluate(() => {
    const url = new URL(globalThis.personalOpenedUrls[0]);
    return { origin: url.origin, path: url.pathname, clientId: url.searchParams.get('client_id'), callback: url.searchParams.get('redirect_uri') };
  });
  assert.equal(auth.origin, 'https://auth.openai.com'); assert.equal(auth.clientId, 'dynamic_agent_client');
  assert.equal(new URL(auth.callback).hostname, '127.0.0.1');
  await page.getByRole('button', { name: '取消连接', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.desktop.personalChatGPT.status())).status, 'disconnected');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.locator('.application-settings-modal').screenshot({ path: join(evidence, `personal-chatgpt-${theme}.png`) });
  }
  await assert.rejects(page.evaluate(() => window.desktop.providers.save({ id: 'chatgpt-personal', baseUrl: 'https://evil.invalid', models: [{ id: 'bad' }] })), /个人 ChatGPT/);
  await assert.rejects(page.evaluate(() => window.desktop.providers.discover({ id: 'chatgpt-personal', baseUrl: 'https://evil.invalid' })), /个人 ChatGPT/);
  // A second renderer cannot call the main window's privileged account IPC.
  const rejected = await application.evaluate(async ({ BrowserWindow }, root) => {
    const other = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: `${root}/electron/preload.cjs` } });
    try { await other.loadURL('about:blank'); return await other.webContents.executeJavaScript('window.desktop.personalChatGPT.status().then(() => false, () => true)'); }
    finally { other.destroy(); }
  }, resolve('.').replaceAll('\\', '/'));
  assert.equal(rejected, true);
  await assert.rejects(readFile(join(profile, 'personal-chatgpt', 'session.enc')), { code: 'ENOENT' });
  assert.deepEqual(errors, []);
  console.log('PASS actual Electron: isolated profile, real trusted IPC and account panel, official browser URL + loopback listener, cancel, secure bridge/no API key, read-only provider, light/dark screenshots. No real login or model call.');
} finally {
  if (application) await application.close();
  await rm(profile, { recursive: true, force: true });
}

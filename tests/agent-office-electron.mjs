import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron } from 'playwright-core';

const evidence = resolve('.tmp/agent-office-electron');
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(evidence, 'profile-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
for (const key of Object.keys(env)) if (/^(?:APORIAX_|PORTABLE_)/.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DEEPSEEK_API_KEY'].includes(key)) delete env[key];
const application = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('.'), '--user-data-dir=' + profile, '--enable-unsafe-swiftshader'], env, timeout: 30000 });
try {
  assert.equal(resolve(await application.evaluate(({ app }) => app.getPath('userData'))), resolve(profile));
  await application.evaluate(({ BrowserWindow, session }) => {
    BrowserWindow.getAllWindows().forEach(win => win.hide());
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  });
  const page = await application.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000);
  await page.waitForFunction(() => Boolean(window.desktop?.agentProfiles));
  await page.evaluate(async () => {
    localStorage.setItem('aporiax.language.v1', 'zh-CN'); localStorage.setItem('aporiax.theme.v2', 'dark');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'office-electron', view: 'office', welcomeDismissed: true }));
    await window.desktop.tasks.load();
    await window.desktop.tasks.save([{ id: 'office-electron', title: '隔离的工位检查', workspacePath: '', workspaceName: '', messages: [], createdAt: new Date().toISOString() }]);
  });
  await page.reload();
  await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  const office = page.locator('.agent-office');
  await office.locator('.ao-scene.ready canvas').waitFor();
  assert.equal(await office.locator('.ao-roster > button').count(), 6, 'Trusted IPC loads actual default roles');
  assert.equal(await office.locator('.ao-warning').count(), 0);
  const contextFlags = await page.evaluate(() => ({ desktop: !!window.desktop, node: typeof window.require, csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content }));
  assert.equal(contextFlags.node, 'undefined'); assert.match(contextFlags.csp, /script-src 'self'/);
  await office.locator('.ao-roster > button').first().click();
  await office.locator('.ao-detail').waitFor();
  assert.equal(await office.locator('.ao-detail textarea').count(), 0);
  await page.locator('.theme-toggle').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await office.getByRole('button', { name: '返回对话', exact: true }).click();
  assert.equal(await office.count(), 0);
  await page.locator('.thread-view-tabs').getByRole('button', { name: 'Agent 工位', exact: true }).click();
  await office.locator('.ao-scene.ready canvas').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS actual Electron: isolated profile, real professional-role IPC, file:// production chunks + CSP + WebGL, dark/light, repeated mount/dispose; no model or user data touched.');
} finally { await application.close(); }

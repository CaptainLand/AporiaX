import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron } from 'playwright-core';
import { windowThemePalette } from '../electron/window-theme.js';

const evidence = resolve('.tmp/desktop-theme');
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(evidence, 'profile-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
for (const key of Object.keys(env)) {
  if (/^(?:APORIAX_|PORTABLE_)/.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DEEPSEEK_API_KEY'].includes(key)) delete env[key];
}
const application = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('.'), '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 });
try {
  const actualProfile = await application.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(resolve(actualProfile), resolve(profile), 'Never test against the real account/task profile');
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.desktop?.theme));
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.evaluate(async () => {
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.theme.v2', 'light');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'theme-test', welcomeDismissed: true }));
    // The real store forbids saving until a successful history load. The UI's
    // hydration can still be starting when the preload first becomes available.
    await window.desktop.tasks.load();
    await window.desktop.tasks.save([{ id: 'theme-test', title: '窗口主题测试', workspacePath: '', workspaceName: '', messages: [], createdAt: new Date().toISOString() }]);
  });
  await page.reload();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.theme-toggle').waitFor();
  // Record arguments at the native boundary, but invoke the real Electron
  // methods. This verifies the trusted renderer IPC and actual window update.
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'AporiaX');
    globalThis.captionCalls = [];
    const original = win.setTitleBarOverlay.bind(win);
    win.setTitleBarOverlay = options => { globalThis.captionCalls.push(options); return original(options); };
  });
  for (const theme of ['dark', 'light', 'dark']) {
    await page.locator('.theme-toggle').click();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await application.evaluate((_, color) => globalThis.captionCalls.at(-1)?.color === color, windowThemePalette(theme).color)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const native = await application.evaluate(({ BrowserWindow }) => ({ last: globalThis.captionCalls.at(-1), background: BrowserWindow.getAllWindows().find(win => win.getTitle() === 'AporiaX').getBackgroundColor() }));
    const palette = windowThemePalette(theme);
    assert.deepEqual(native.last, { color: palette.color, symbolColor: palette.symbolColor, height: palette.height });
    assert.equal(native.background.toLowerCase(), palette.backgroundColor);
    const titlebarColor = await page.locator('.titlebar').evaluate(el => {
      const rgb = getComputedStyle(el).backgroundColor.match(/\d+/g).slice(0, 3);
      return '#' + rgb.map(value => Number(value).toString(16).padStart(2, '0')).join('');
    });
    assert.equal(native.last.color, titlebarColor, 'Native caption background must match the actual titlebar');
    console.log(`PASS actual Electron ${theme}: trusted theme IPC, native caption ${native.last.color}, window ${native.background}, matching renderer.`);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(windowThemePalette('invalid'), windowThemePalette('light'));
  console.log('PASS: isolated desktop profile; dark/light/dark toggle; zero browser errors; no model, login or user data touched.');
} finally { await application.close(); }

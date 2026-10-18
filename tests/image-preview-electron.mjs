import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron } from 'playwright-core';
const evidence = resolve('.tmp/image-preview-electron'); await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(evidence, 'profile-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
for (const key of Object.keys(env)) if (/^(?:APORIAX_|PORTABLE_)/.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DEEPSEEK_API_KEY'].includes(key)) delete env[key];
let app;
try {
  app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('.'), '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 });
  assert.equal(resolve(await app.evaluate(({ app }) => app.getPath('userData'))), profile);
  await app.evaluate(() => { globalThis.fetch = async () => { throw Error('No external calls in image preview test'); }; });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.desktop?.tasks);
  const image = await app.evaluate(({ nativeImage }) => 'data:image/png;base64,' + nativeImage.createFromBitmap(Buffer.alloc(40 * 40 * 4, 160), { width: 40, height: 40 }).toPNG().toString('base64'));
  await page.evaluate(async ({ image, profile }) => {
    localStorage.setItem('aporiax.language.v1', 'zh-CN'); localStorage.setItem('aporiax.theme.v2', 'dark');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'image-demo', welcomeDismissed: true }));
    await window.desktop.tasks.load();
    await window.desktop.tasks.save([{ id: 'image-demo', title: '图片测试', workspaceName: '演示', workspacePath: profile, createdAt: '2026-10-19T00:00:00Z', messages: [{ id: 'u', role: 'user', content: '图片预览测试', attachments: [{ id: 'image', name: 'private-demo.png', kind: 'image', type: 'image/png', dataUrl: image }] }] }]);
  }, { image, profile });
  await page.reload();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  const thumbnail = page.locator('.message-attachment-grid img'); await thumbnail.waitFor();
  assert.equal(await page.locator('.message-attachment-grid figcaption').count(), 0);
  await thumbnail.click();
  const dialog = page.getByRole('dialog', { name: '查看图片', exact: true }); await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector('.image-preview-dialog img')?.naturalWidth === 40);
  assert.equal(await page.locator('.workbench-shell').count(), 0);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '打开工作侧栏', exact: true }).click();
  await page.locator('.workbench-empty-card').filter({ hasText: '浏览器' }).click();
  await page.locator('.workbench-browser').waitFor();
  const visibleViews = () => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'AporiaX');
    return win.contentView.children.filter(view => view.webContents && view.webContents.id !== win.webContents.id && view.getVisible()).length;
  });
  const waitViews = async count => {
    for (let attempt = 0; attempt < 30; attempt++) { if (await visibleViews() === count) return; await page.waitForTimeout(100); }
    assert.equal(await visibleViews(), count);
  };
  await waitViews(1);
  const tabs = await page.locator('.workbench-tab').count();
  await thumbnail.click(); await dialog.waitFor(); await waitViews(0);
  assert.equal(await page.locator('.workbench-tab').count(), tabs, 'Browser tab and layout survive the popup');
  await page.screenshot({ path: join(evidence, 'popup-over-native-browser.png') });
  assert.equal(await dialog.locator('button, header').count(), 0);
  assert.match(await dialog.evaluate(el => getComputedStyle(el, '::backdrop').backdropFilter), /blur/);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  await waitViews(1);
  assert.equal(await page.locator('.workbench-tab').count(), tabs);
  assert.deepEqual(errors, []);
  console.log('PASS isolated Electron: persisted attachment loads through real blob storage; no filename mask; modal does not open sidebar; native browser view hides beneath modal and restores without changing tabs. No model calls.');
} finally { await app?.close(); }

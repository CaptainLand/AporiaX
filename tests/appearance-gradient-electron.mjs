import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron } from 'playwright-core';

const evidence = resolve('.tmp/gradient-electron'); await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(evidence, 'profile-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
for (const key of Object.keys(env)) if (/^(?:APORIAX_|PORTABLE_)/.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DEEPSEEK_API_KEY'].includes(key)) delete env[key];
let app, page;
const errors = [];
async function launch() {
  app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('.'), '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 });
  assert.equal(resolve(await app.evaluate(({ app }) => app.getPath('userData'))), profile);
  await app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_details, callback) => callback({ cancel: true }));
    globalThis.fetch = async () => { throw Error('No external requests in gradient test'); };
  });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.desktop?.appearance));
  await page.locator('.titlebar').waitFor();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
}
const open = async () => { await page.getByRole('button', { name: '打开 AporiaX 设置', exact: true }).click(); await page.getByRole('button', { name: '个性化', exact: true }).click(); };
try {
  await launch();
  await page.evaluate(async () => {
    localStorage.setItem('aporiax.language.v1', 'zh-CN'); localStorage.setItem('aporiax.theme.v2', 'dark');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'gradient-demo', welcomeDismissed: true }));
    await window.desktop.tasks.load();
    await window.desktop.tasks.save([{ id: 'gradient-demo', title: '渐变演示', workspaceName: '', workspacePath: '', createdAt: '2026-10-19T00:00:00Z', messages: [] }]);
    let state = await window.desktop.appearance.request({ action: 'get' });
    state = await window.desktop.appearance.request({ action: 'preferences', revision: state.revision, enabled: true, base: 'dark' });
    state = await window.desktop.appearance.request({ action: 'save', revision: state.revision, theme: { name: '保留旧主题', gradient: { enabled: true, start: '#13271d', end: '#273a53', angle: 90, strength: .65 }, base: 'dark', colors: { accent: '#31c48d', background: '#0f1114', panel: '#14161a', text: '#eaedf2', quota: '#c49b50' }, regions: { sidebar: '#183021' }, components: { composer: { radius: 0 } } } });
    await window.desktop.appearance.request({ action: 'preferences', revision: state.revision, selectedId: state.themes[0].id });
  });
  await page.reload();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.waitForFunction(() => document.documentElement.dataset.customTheme?.startsWith('theme-'));
  assert.equal(await page.locator('.sidebar').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(20, 22, 26)');
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'AporiaX');
    const original = win.setTitleBarOverlay.bind(win); globalThis.gradientCaptions = [];
    win.setTitleBarOverlay = value => { const result = original(value); globalThis.gradientCaptions.push(value); return result; };
  });
  await open();
  await page.getByRole('button', { name: '编辑主题 保留旧主题', exact: true }).click();
  assert.equal(await page.getByRole('switch', { name: '开启整体渐变' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '组件细节', exact: true }).count(), 0);
  await page.getByLabel('主题主色', { exact: true }).fill('#a3c457');
  const png = await app.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 160), { width: 32, height: 32 }).toPNG().toString('base64'));
  const imagePath = join(profile, 'basic-image.png'); await writeFile(imagePath, Buffer.from(png, 'base64'));
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, imagePath);
  await page.getByRole('button', { name: '选择图片', exact: true }).click();
  await page.getByLabel('主题背景图片', { exact: true }).waitFor();
  await page.getByRole('button', { name: '保存并应用', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.themeBackground === 'true');
  assert.equal(await page.locator('html').getAttribute('data-theme-gradient'), null);
  assert.equal(await app.evaluate(() => globalThis.gradientCaptions.at(-1)?.color), '#14161a');
  const before = await page.evaluate(() => window.desktop.appearance.request({ action: 'get' }));
  assert.equal(before.themes[0].components.composer.radius, 0);
  assert.equal(before.themes[0].gradient.enabled, true);
  assert.equal(before.themes[0].colors.quota, '#c49b50');
  assert.match(await page.locator('.thread-body').evaluate(el => getComputedStyle(el).backgroundImage), /data:image\/png/);
  await app.close(); app = null; await launch();
  await page.waitForFunction(() => document.documentElement.dataset.customTheme && document.documentElement.dataset.themeBackground === 'true');
  const after = await page.evaluate(() => window.desktop.appearance.request({ action: 'get' }));
  assert.equal(after.error, undefined); assert.deepEqual(after.themes, before.themes);
  assert.equal(await page.locator('html').getAttribute('data-theme-gradient'), null);
  const persisted = JSON.parse(await readFile(join(profile, 'appearance', 'themes.json'), 'utf8'));
  assert.deepEqual(persisted.themes, before.themes);
  await open();
  await page.getByRole('button', { name: '恢复默认外观', exact: true }).click();
  await page.waitForFunction(() => !document.documentElement.dataset.customTheme && !document.documentElement.dataset.themeBackground);
  assert.equal((await page.evaluate(() => window.desktop.appearance.request({ action: 'get' }))).themes.length, 1);
  assert.deepEqual(errors, []);
  console.log('PASS isolated Electron rollback: original basic UI, archived gradient and advanced settings preserved/inactive, solid native titlebar, image import and restart restore, full reset; no external requests.');
} finally { await app?.close(); }

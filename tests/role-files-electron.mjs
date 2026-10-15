import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron } from 'playwright-core';

const evidence = resolve('.tmp/role-files-electron');
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(evidence, 'profile-'));
const workspace = join(profile, 'demo-workspace');
await mkdir(workspace);
await writeFile(join(workspace, '样例 文件.txt'), 'Safe test data; not a real user workspace.');
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
for (const key of Object.keys(env)) if (/^(?:APORIAX_|PORTABLE_)/.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DEEPSEEK_API_KEY'].includes(key)) delete env[key];
const application = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('.'), '--user-data-dir=' + profile], env, timeout: 30000 });
try {
  assert.equal(resolve(await application.evaluate(({ app }) => app.getPath('userData'))), resolve(profile));
  await application.evaluate(({ BrowserWindow, session, Menu, clipboard, shell }) => {
    BrowserWindow.getAllWindows().forEach(window => window.hide());
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
    // Exercise actual trusted IPC + native menu construction. Select the test
    // action deterministically without displaying a menu or opening other apps.
    globalThis.fileMenuFixture = { action: 'add-to-chat', calls: [], menus: [] };
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = template => {
      const menu = build(template);
      if (template.some(item => item.id === 'add-to-chat')) {
        globalThis.fileMenuFixture.menus.push(template.map(({ id, label, enabled }) => ({ id, label, enabled })));
        menu.popup = options => { const item = template.find(item => item.id === globalThis.fileMenuFixture.action); if (item?.enabled !== false) item?.click?.(); options.callback?.(); };
      }
      return menu;
    };
    clipboard.writeText = text => globalThis.fileMenuFixture.calls.push(['copy', text]);
    shell.openPath = async path => { globalThis.fileMenuFixture.calls.push(['open', path]); return ''; };
    shell.showItemInFolder = path => globalThis.fileMenuFixture.calls.push(['reveal', path]);
  });
  const page = await application.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000);
  await page.waitForFunction(() => Boolean(window.desktop?.workspace?.fileMenu));
  await page.evaluate(async workspace => {
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'file-menu-electron', view: 'workspace', welcomeDismissed: true }));
    await window.desktop.tasks.load();
    await window.desktop.tasks.save([{ id: 'file-menu-electron', title: '文件菜单隔离测试', workspacePath: workspace, workspaceName: '演示工作区', messages: [], createdAt: new Date().toISOString() }]);
  }, workspace);
  await page.reload();
  await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  const tabs = page.locator('.thread-view-tabs');
  await tabs.getByRole('button', { name: '工作区', exact: true }).click();
  const file = page.locator('.thread .workspace-tree button').filter({ hasText: '样例 文件.txt' });
  await file.waitFor();
  await file.click({ button: 'right' });
  const composer = page.locator('.thread .composer textarea');
  await page.waitForFunction(() => document.querySelector('.thread .composer textarea')?.value.includes('@{./样例 文件.txt}'));
  assert.equal(await composer.inputValue(), '@{./样例 文件.txt} ');
  assert.equal(await composer.evaluate(element => element === document.activeElement), true);
  const menus = await application.evaluate(() => globalThis.fileMenuFixture.menus);
  assert(menus.at(-1).some(item => item.id === 'add-to-chat' && item.enabled));
  for (const action of ['copy-path', 'copy-relative', 'reveal', 'open-default']) {
    await application.evaluate((_electron, action) => { globalThis.fileMenuFixture.action = action; }, action);
    const result = await page.evaluate(async workspace => window.desktop.workspace.fileMenu({ workspacePath: workspace, path: '样例 文件.txt' }), workspace);
    assert.equal(result.action, action);
  }
  const calls = await application.evaluate(() => globalThis.fileMenuFixture.calls);
  assert.deepEqual(calls.map(call => call[0]), ['copy', 'copy', 'reveal', 'open']);
  assert.equal(calls[0][1], join(workspace, '样例 文件.txt'));
  assert.equal(calls[1][1], '样例 文件.txt');
  await page.evaluate(async () => {
    const settings = await window.desktop.agentProfiles.get();
    await window.desktop.agentProfiles.save({ ...settings, profiles: [...settings.profiles, { ...settings.profiles[0], id: 'sample-role', name: '测试自定义角色' }] });
    const stored = await window.desktop.agentProfiles.get();
    if (stored.profiles.length !== 6) throw new Error('Role was not persisted');
    await window.desktop.agentProfiles.save({ ...stored, profiles: stored.profiles.filter(profile => profile.id !== 'sample-role') });
    const final = await window.desktop.agentProfiles.get();
    if (final.profiles.length !== 5) throw new Error('Custom role deletion was not persisted');
    try { await window.desktop.agentProfiles.save({ ...final, profiles: final.profiles.slice(1) }); throw new Error('Built-in deletion unexpectedly allowed'); }
    catch (error) { if (!error.message.includes('内置角色')) throw error; }
  });
  await page.screenshot({ path: join(evidence, 'file-added-to-chat.png') });
  assert.deepEqual(errors, []);
  console.log('PASS actual Electron: isolated profile, production file menu trusted IPC + main composer integration, native menu template, safe OS action routing, persistent custom role deletion + built-in protection. No model requests, real workspaces, clipboard changes or external applications.');
} finally { await application.close(); }

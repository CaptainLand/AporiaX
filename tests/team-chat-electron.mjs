import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron } from 'playwright-core';

await mkdir('.tmp/team-electron', { recursive: true });
const profile = await mkdtemp(resolve('.tmp/team-electron/profile-'));
const workspace = join(profile, 'demo-workspace'); await mkdir(workspace);
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
for (const key of Object.keys(env)) if (/^(APORIAX_|PORTABLE_)/.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DEEPSEEK_API_KEY'].includes(key)) delete env[key];
const application = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('.'), '--user-data-dir=' + profile], env, timeout: 30000 });
try {
  assert.equal(resolve(await application.evaluate(({ app }) => app.getPath('userData'))), resolve(profile));
  await application.evaluate(({ BrowserWindow, session }) => {
    BrowserWindow.getAllWindows().forEach(w => w.hide());
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
    globalThis.teamTestCalls = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('http://127.0.0.1:19876/')) {
        globalThis.teamTestCalls.push(JSON.parse(init.body));
        return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '隔离测试回复，未访问真实模型。' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error('External network disabled for isolated test');
    };
  });
  const page = await application.firstWindow(), errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(20000);
  await page.waitForFunction(() => Boolean(window.desktop?.teamChat));
  await page.evaluate(async workspace => {
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'team-test', view: 'dialogue', welcomeDismissed: true }));
    await window.desktop.providers.save({ id: 'team-mock', name: '隔离测试', baseUrl: 'http://127.0.0.1:19876/v1', models: [{ id: 'team-model', name: '隔离模型' }] });
    await window.desktop.tasks.load();
    await window.desktop.tasks.save([{ id: 'team-test', title: '团队消息演示', workspacePath: workspace, workspaceName: '演示工作区', providerId: 'team-mock', modelId: 'team-model', messages: [], createdAt: new Date().toISOString() }]);
  }, workspace);
  await page.reload();
  await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.thread-view-tabs').getByRole('button', { name: 'Agent 工位', exact: true }).click();
  await page.locator('.agent-office').waitFor();
  await page.getByRole('button', { name: '团队消息', exact: true }).click();
  await page.locator('.tm-room').first().waitFor();
  await page.locator('.tm-room').filter({ hasText: '工作群' }).click();
  const composer = page.getByRole('textbox', { name: '团队聊天消息' });
  await composer.fill('你好，主管');
  await page.getByRole('button', { name: '发送团队消息' }).click();
  await page.locator('.tm-assistant[data-status="completed"]').waitFor();
  assert.match(await page.locator('.tm-assistant').innerText(), /隔离测试回复/);
  const calls = await application.evaluate(() => globalThis.teamTestCalls);
  assert.equal(calls.length, 1); assert.equal(calls[0].tools, undefined);
  const source = await page.evaluate(() => window.desktop.tasks.load());
  assert.equal(source.find(t => t.id === 'team-test').messages.length, 0, 'ordinary chat must not start the main task');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `.tmp/qa/team-office-group-${theme}.png` });
  }
  await page.locator('.ao-roster button').first().click();
  await page.getByRole('button', { name: '聊一聊', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.team-chat')?.dataset.room.startsWith('role:') && document.querySelector('.tm-welcome'));
  assert.equal(await page.locator('.tm-message').count(), 0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `.tmp/qa/team-office-${theme}.png` });
  }
  assert.deepEqual(errors, []);
  console.log('PASS Electron: isolated userData, real main/preload IPC, office + workstation entry, real provider adapter with fake SSE, no main task mutation, private/group isolation.');
} finally { await application.close(); }

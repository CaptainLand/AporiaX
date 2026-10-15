import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer, preview } from 'vite';
import { chromium } from 'playwright-core';
import { defaultRoleSettings } from '../shared/professional-roles.js';

const production = process.argv.includes('--production');
const server = production ? await preview({ preview: { host: '127.0.0.1', port: 0 } }) : await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
if (!production) await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--enable-unsafe-swiftshader'] });
const errors = [], requests = [];
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, bypassCSP: !production });
await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
await context.addInitScript(({ roles }) => {
  if (!sessionStorage.officeLoaded) {
    localStorage.clear(); localStorage.setItem('aporiax.language.v1', 'zh-CN'); localStorage.setItem('aporiax.theme.v2', 'light');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'office-demo', welcomeDismissed: true })); sessionStorage.officeLoaded = 'true';
  }
  const task = { id: 'office-demo', title: '设计项目工作台', workspaceName: '星河工作台', workspacePath: 'D:/Demo/Starlight', providerId: 'fixture', modelId: 'fixture-model', executionMode: 'safe', approvalMode: 'smart-auto', messages: [] };
  const calls = [], listeners = new Set();
  window.officeFixture = { calls, roles, workers: [], runInput: null, finish: null,
    emit(event) { for (const listener of listeners) listener({ runId: this.runInput.runId, timestamp: new Date().toISOString(), ...event }); },
  };
  const record = (kind, value) => calls.push({ kind, value });
  const control = (kind, input) => { record(kind, input); return Promise.resolve(true); };
  window.desktop = {
    theme: { set: async () => {} }, account: { get: async () => ({ status: 'anonymous' }) },
    tasks: { load: async () => [task, { ...task, id: 'office-other', title: '整理使用说明', messages: [] }], save: async input => { window.officeFixture.saved = input; }, diagnostics: async () => [] },
    providers: { list: async () => [{ id: 'fixture', name: '演示模型服务', models: [{ id: 'fixture-model', name: '演示模型' }] }] },
    harness: {
      onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); }, recoverableRuns: async () => [],
      run: input => { record('run', input); window.officeFixture.runInput = input; return new Promise(resolve => { window.officeFixture.finish = resolve; }); },
      steer: input => control('main-steer', input), interrupt: input => control('main-stop', input),
      pause: input => { window.officeFixture.emit({ type: 'control.paused', pauseReasons: ['user'] }); return control('main-pause', input); },
      resume: input => { window.officeFixture.emit({ type: 'control.resumed', pauseReasons: [] }); return control('main-resume', input); },
    },
    sandbox: { status: async () => ({ localAvailable: true }) },
    agentProfiles: { get: async () => window.officeFixture.roles,
      list: async input => { record('list', input); return window.officeFixture.workers; },
      steer: input => control('child-steer', input), stop: input => control('child-stop', input) },
    core: { skills: async () => ({ skills: [] }), capabilities: async () => ({ capabilities: [] }) },
    files: { list: async () => [] },
    workbench: { subscribe: () => () => {}, request: async input => input.action === 'list' ? [] : true },
  };
}, { roles: defaultRoleSettings() });

const page = await context.newPage();
page.setDefaultTimeout(20000);
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => requests.push(request.url()));
const nav = page.locator('.thread-view-tabs');
const office = page.locator('.agent-office');
const member = id => office.locator(`.ao-roster > button[data-agent-id="${id}"]`);
const state = (id, value) => page.waitForFunction(({ id, value }) => document.querySelector(`.ao-roster > button[data-agent-id="${id}"]`)?.dataset.state === value, { id, value });
const emit = async event => page.evaluate(event => window.officeFixture.emit(event), event);
const enter = async () => {
  await nav.getByRole('button', { name: 'Agent 工位', exact: true }).click();
  await office.locator('.ao-scene.ready canvas').waitFor();
};
try {
  await page.goto(base);
  await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  assert.deepEqual(await nav.locator('button').allTextContents(), ['对话', '执行记录', '工作区', '项目知识', 'Agent 工位']);
  assert(!requests.some(url => /office-scene|AgentOffice/.test(url)), 'Office is lazy; no renderer cost in chat');
  await page.getByRole('textbox', { name: '任务输入', exact: true }).fill('草稿保留检查');
  await enter();
  assert.equal(await office.locator('.ao-roster > button').count(), 6);
  assert.equal(await page.getByRole('textbox', { name: '任务输入', exact: true }).count(), 0, 'Composer is hidden in office');
  assert.equal(await page.locator('iframe').count(), 0, 'Office is native to renderer, not a prototype iframe');
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ao-camera output').textContent === '115%');
  await page.getByRole('button', { name: '回到全景', exact: true }).click();
  await member('lead').click(); await office.locator('.ao-detail').waitFor();
  assert.equal(await office.locator('.ao-detail textarea').count(), 0, 'Idle avatars cannot launch or stop a run');
  await page.keyboard.press('Escape');
  await office.getByRole('button', { name: '返回对话', exact: true }).click();
  assert.equal(await office.count(), 0);
  assert.equal(await page.locator('.ao-scene canvas').count(), 0, 'Scene unmounted when leaving');
  assert.equal(await page.getByRole('textbox', { name: '任务输入', exact: true }).inputValue(), '草稿保留检查');
  await page.getByRole('textbox', { name: '任务输入', exact: true }).fill('制作一个清爽的项目工作台页面');
  await page.getByRole('textbox', { name: '任务输入', exact: true }).press('Enter');
  await page.waitForFunction(() => !!window.officeFixture.runInput);
  await enter(); await state('lead', 'waiting');
  await emit({ type: 'response.activity' });
  await state('lead', 'waiting');
  assert.match(await member('lead').innerText(), /等待模型响应/);
  await emit({ type: 'response.delta', delta: '正在处理需求。' });
  await state('lead', 'working');
  await emit({ type: 'response.reset' }); await state('lead', 'waiting');
  const initialPoll = await page.evaluate(() => window.officeFixture.calls.find(c => c.kind === 'list'));
  const runInput = await page.evaluate(() => window.officeFixture.runInput);
  assert.deepEqual(initialPoll.value, { taskId: 'office-demo', runId: runInput.runId }, 'Run ID available before delegation');
  await emit({ type: 'subagent.profile', agentId: 'builder-1', role: 'builder', profileId: 'builder', profileName: '开发', phase: 'queued', task: '实现页面结构' });
  await emit({ type: 'subagent.started', agentId: 'builder-1', role: 'builder', task: '实现页面结构' });
  await emit({ type: 'subagent.configured', agentId: 'builder-1', role: 'builder', model: 'fixture-model', provider: 'fixture' });
  await emit({ type: 'subagent.budget', agentId: 'builder-1', role: 'builder', budget: { requests: 2, tokens: 1234, unknown: 0 } });
  await state('builder-1', 'waiting');
  await emit({ type: 'subagent.tool.started', agentId: 'builder-1', role: 'builder', tool: 'apply_patch' });
  await state('builder-1', 'working');
  await member('builder-1').click();
  assert.match(await office.locator('.ao-detail').innerText(), /1234/);
  assert.match(await office.locator('.ao-detail').innerText(), /fixture-model/);
  await office.getByRole('textbox', { name: '追加要求', exact: true }).fill('注意键盘可访问性');
  await office.getByRole('button', { name: '追加要求', exact: true }).click();
  await office.locator('.ao-notice').filter({ hasText: '追加要求已提交' }).waitFor();
  await office.getByRole('button', { name: '停止', exact: true }).click();
  const childCalls = await page.evaluate(() => window.officeFixture.calls.filter(c => c.kind.startsWith('child')));
  assert.deepEqual(childCalls, [
    { kind: 'child-steer', value: { taskId: 'office-demo', runId: runInput.runId, agentId: 'builder-1', task: '注意键盘可访问性' } },
    { kind: 'child-stop', value: { taskId: 'office-demo', runId: runInput.runId, agentId: 'builder-1' } },
  ]);
  // Command dispatch is not a fabricated terminal state; await runtime event.
  await state('builder-1', 'working');
  await emit({ type: 'subagent.completed', agentId: 'builder-1', role: 'builder', summary: '界面结构已完成。' });
  await state('builder-1', 'sleeping');
  assert.equal(await office.locator('.ao-detail textarea').count(), 0);
  await member('lead').click();
  await office.getByRole('textbox', { name: '追加要求', exact: true }).fill('继续完成验证');
  await office.getByRole('button', { name: '追加要求', exact: true }).click();
  await office.getByRole('button', { name: '暂停任务', exact: true }).click();
  await office.getByRole('button', { name: '继续任务', exact: true }).waitFor();
  await office.getByRole('button', { name: '继续任务', exact: true }).click();
  await office.getByRole('button', { name: '暂停任务', exact: true }).waitFor();
  await office.getByRole('button', { name: '停止', exact: true }).click();
  const mainCalls = await page.evaluate(() => window.officeFixture.calls.filter(c => c.kind.startsWith('main')));
  assert.equal(mainCalls[0].value.runId, runInput.runId);
  assert.equal(mainCalls[0].value.message.content, '继续完成验证');
  assert.deepEqual(mainCalls.slice(1).map(c => [c.kind, c.value]), [['main-pause', runInput.runId], ['main-resume', runInput.runId], ['main-stop', runInput.runId]]);
  await page.keyboard.press('Escape');
  for (let i = 2; i <= 4; i++) await emit({ type: 'subagent.profile', agentId: `builder-${i}`, role: 'builder', profileId: 'builder', profileName: '开发', phase: i === 2 ? 'tool' : 'waiting_dependencies' });
  assert.equal(await office.locator('.ao-roster > button').count(), 9);
  await member('builder-4').click();
  await office.locator('.ao-scene.ready canvas').waitFor();
  assert.match(await office.locator('.ao-zones').innerText(), /2 \/ 2/);
  assert.match(await office.locator('.ao-detail').innerText(), /等待依赖验收/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '上一个工位分区', exact: true }).click();
  await office.locator('.ao-scene.ready canvas').waitFor();
  await emit({ type: 'subagent.started', agentId: 'scout', role: 'explore', task: '检查工作区结构' });
  await emit({ type: 'subagent.tool.started', agentId: 'scout', role: 'explore', tool: 'read_file' });
  await state('scout', 'working');
  await page.locator('.toast').waitFor({ state: 'hidden' });
  await mkdir('output/agent-office', { recursive: true });
  await page.screenshot({ path: 'output/agent-office/integrated-light.png' });
  const before = await office.boundingBox();
  await page.locator('.theme-toggle').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.deepEqual(await office.boundingBox(), before, 'Theme has identical layout');
  await page.screenshot({ path: 'output/agent-office/integrated-dark.png' });
  // Live settings changes refresh seats; they do not create new executions.
  await page.evaluate(() => { window.officeFixture.roles.profiles.push({ ...window.officeFixture.roles.profiles[0], id: 'designer', name: '界面设计' }); window.dispatchEvent(new Event('aporiax:roles-updated')); });
  await member('profile:designer').waitFor();
  assert.equal(await page.evaluate(() => window.officeFixture.calls.filter(c => c.kind === 'run').length), 1);
  await nav.getByRole('button', { name: '对话', exact: true }).click();
  const polls = await page.evaluate(() => window.officeFixture.calls.filter(c => c.kind === 'list').length);
  await page.waitForTimeout(2200);
  assert.equal(await page.evaluate(() => window.officeFixture.calls.filter(c => c.kind === 'list').length), polls, 'No background polling or GPU scene after leaving');
  await enter();
  await page.evaluate(() => window.officeFixture.finish({ status: 'completed', content: '演示完成。' }));
  await state('lead', 'sleeping');
  assert.equal(await member('builder-2').getAttribute('data-state'), 'offline', 'Ended task cannot leave fake running workers');
  await member('lead').click(); assert.equal(await office.locator('.ao-detail textarea').count(), 0);
  await page.getByRole('button', { name: '整理使用说明', exact: true }).click();
  await enter();
  assert.equal(await member('builder-1').count(), 0, 'Task switch clears historical workers');
  assert.equal(await member('lead').getAttribute('data-state'), 'sleeping');
  await page.setViewportSize({ width: 900, height: 760 });
  const geometry = await office.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth, height: el.clientHeight, canvas: el.querySelector('canvas').clientHeight }));
  assert.equal(geometry.client, geometry.scroll, 'Narrow view contains its own horizontal roster');
  assert(geometry.canvas > 200 && geometry.height > geometry.canvas);
  await page.reload();
  await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await office.locator('.ao-scene.ready canvas').waitFor();
  assert.equal(await nav.locator('button.active').innerText(), 'Agent 工位', 'View restored after app reload');
  assert(!requests.some(url => /:5188\//.test(url)), 'No dependency on the demo preview server');
  assert.deepEqual(errors, []);
  // Deliberately unavailable graphics: details stay usable, no model calls.
  await page.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(kind, ...args) { return /webgl/i.test(kind) ? null : original.call(this, kind, ...args); }; });
  await page.reload();
  await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await office.getByRole('button', { name: '重试场景', exact: true }).waitFor();
  await member('lead').click(); await office.locator('.ao-detail').waitFor();
  assert.equal(await page.evaluate(() => window.officeFixture.calls.filter(c => c.kind === 'run').length), 0);
  console.log(`PASS Agent office ${production ? 'production (CSP enforced)' : 'development'}: main navigation, real renderer events/controls with mock IPC, honest statuses, multi-zone/custom roles, theme parity, task isolation, draft/view persistence, lazy load/unmount and WebGL fallback.`);
} catch (error) {
  console.error('Office browser errors:', errors);
  console.error('Visible office:', await office.count() ? await office.innerText() : 'not mounted');
  throw error;
} finally { await context.close(); await browser.close(); await server.close(); }

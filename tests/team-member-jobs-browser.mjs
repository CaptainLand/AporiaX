import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { createTeamChatService } from '../electron/team-chat/service.js';
import { defaultRoleSettings } from '../shared/professional-roles.js';

await mkdir('.tmp/qa', { recursive: true });
const root = await mkdtemp(resolve('.tmp/member-browser-')), connections = new Set();
const task = { id: 'demo', title: '隔离演示', workspacePath: root, messages: [] }, original = structuredClone(task);
const approvals = new Map(); let calls = 0, jobs = 0;
const service = createTeamChatService({ dataDirectory: root, loadTask: async () => structuredClone(task), loadTasks: async () => [task], loadRoles: async () => defaultRoleSettings(),
  resolveProvider: async () => ({ id: 'demo', models: [{ id: 'mock' }] }),
  publish: event => connections.forEach(res => res.write('data: ' + JSON.stringify(event) + '\n\n')),
  callProvider: async ({ body }) => { calls++; return body.messages.at(-1).content === '请独立检查'
    ? { message: { content: '', tool_calls: [{ id: 'draft', function: { name: 'propose_member_job', arguments: '{"instruction":"检查项目"}' } }] } }
    : { message: { content: `已查看本角色记录，简报 ${calls}。` } }; },
  executeJob: async (job, { signal, onEvent }) => {
    jobs++;
    if (job.instruction === '需要审批') {
      const allowed = await new Promise((resolve, reject) => {
        approvals.set(job.runId, resolve);
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        onEvent({ type: 'approval.required', approval: { id: 'approval-fixture', title: '运行验证命令', command: 'npm test' } }).catch(reject);
      });
      await onEvent({ type: 'approval.resolved' });
      return { status: allowed ? 'completed' : 'failed', content: allowed ? '模拟检查完成。' : '用户拒绝，未运行命令。' };
    }
    if (job.instruction === '等待取消') await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    return { status: 'completed', content: '模拟任务完成。' };
  }, respondJobApproval: (runId, id, response) => { if (id !== 'approval-fixture' || !approvals.has(runId)) return false; approvals.get(runId)(response.approved); approvals.delete(runId); return true; },
});
const server = await createServer({ plugins: [{ name: 'member-test', configureServer(server) {
  server.middlewares.use('/__team-events', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.write(': connected\n\n'); connections.add(res); req.on('close', () => connections.delete(res)); });
  server.middlewares.use('/__team-test', async (req, res) => { try { let raw = ''; for await (const chunk of req) raw += chunk; const result = await service.request(JSON.parse(raw)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); } });
} }], server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1040, height: 920 }, reducedMotion: 'reduce' }), errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(20000); page.setDefaultNavigationTimeout(60000);
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/team-chat.html');
  await page.locator('.tm-room').first().waitFor(); await page.locator('.tm-room').filter({ hasText: '工作群' }).click();
  await page.getByRole('textbox', { name: '团队聊天消息' }).fill('@');
  await page.getByRole('textbox', { name: '团队聊天消息' }).press('Enter');
  assert.match(await page.locator('.tm-recipients').innerText(), /全体成员/);
  assert.equal(calls, 0, 'Enter selects a mention without sending a model request');
  await page.getByRole('button', { name: '移除回复角色 全体成员' }).click();
  await page.getByRole('button', { name: '邀请角色', exact: true }).click();
  await page.getByRole('group', { name: '选择回复角色' }).getByRole('button', { name: '全体成员', exact: true }).click();
  assert.match(await page.locator('.tm-recipients').innerText(), /全体成员/);
  await page.getByRole('textbox', { name: '团队聊天消息' }).fill('大家汇报');
  await page.getByRole('button', { name: '发送团队消息' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tm-assistant[data-status="completed"]').length === 6);
  assert.equal(calls, 6);
  for (const name of ['探奇', '察微', '验准', '搭匠']) {
    await page.getByRole('button', { name: '邀请角色', exact: true }).click();
    await page.getByRole('group', { name: '选择回复角色' }).getByRole('button', { name, exact: true }).click();
  }
  assert.equal(await page.locator('.tm-recipients button').count(), 4);
  await page.getByRole('textbox', { name: '团队聊天消息' }).fill('四位补充'); await page.getByRole('button', { name: '发送团队消息' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tm-assistant[data-status="completed"]').length === 10);
  assert.equal(calls, 10);

  await page.getByRole('textbox', { name: '团队聊天消息' }).fill('请独立检查');
  await page.getByRole('button', { name: '发送团队消息' }).click();
  await page.getByRole('button', { name: '确认独立任务', exact: true }).waitFor();
  assert.equal(jobs, 0);
  await page.getByRole('button', { name: '确认独立任务', exact: true }).click();
  await page.getByRole('button', { name: '确认启动', exact: true }).waitFor();
  assert.equal(jobs, 0, 'model draft is still not authority to execute');
  await page.getByRole('button', { name: '取消', exact: true }).click();

  await page.getByRole('button', { name: '派发独立任务', exact: true }).click();
  await page.getByRole('combobox', { name: '受领成员' }).selectOption('verify');
  await page.getByRole('textbox', { name: '独立任务目标' }).fill('需要审批');
  await page.getByRole('button', { name: '核对任务' }).click();
  await page.getByRole('button', { name: '确认启动' }).waitFor(); assert.equal(jobs, 0, 'reviewing a draft must not execute');
  await page.getByRole('button', { name: '确认启动' }).click();
  await page.getByRole('button', { name: '允许这一次' }).waitFor();
  assert.equal(jobs, 1);
  await page.screenshot({ path: '.tmp/qa/member-job-approval-light.png' });
  await page.getByRole('button', { name: '允许这一次' }).click();
  await page.locator('.tm-job-item[data-job-status="completed"]').waitFor();
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.locator('.tm-mentioned-user').waitFor();
  assert.match(await page.locator('.tm-mentioned-user').innerText(), /@你.*已完成/s);
  assert.deepEqual(task, original); assert.deepEqual(await page.evaluate(() => window.fixture.transfers), []);

  await page.evaluate(() => window.fixture.language('en'));
  await page.getByRole('button', { name: 'Member jobs', exact: true }).click();
  assert.match(await page.getByRole('dialog').innerText(), /Checko/);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.evaluate(() => window.fixture.language('zh-CN'));
  await page.getByRole('button', { name: '派发独立任务', exact: true }).click();
  await page.getByRole('combobox', { name: '受领成员' }).selectOption('review');
  await page.getByRole('textbox', { name: '独立任务目标' }).fill('等待取消');
  await page.getByRole('button', { name: '核对任务' }).click(); await page.getByRole('button', { name: '确认启动' }).click();
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.getByRole('textbox', { name: '团队聊天消息' }).fill('后台任务不锁住聊天输入');
  assert.equal(await page.getByRole('button', { name: '发送团队消息' }).isEnabled(), true);
  await page.getByRole('button', { name: '成员独立任务', exact: true }).click();
  await page.locator('.tm-job-item[data-job-status="running"]').getByRole('button', { name: '取消任务', exact: true }).click();
  await page.locator('.tm-job-item[data-job-status="cancelled"]').waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.evaluate(() => { document.getElementById('test-pane').style.width = '360px'; });
    assert(await page.getByRole('dialog').evaluate(e => e.scrollWidth <= e.clientWidth));
    await page.screenshot({ path: `.tmp/qa/member-jobs-${theme}.png` });
  }
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await page.locator('.tm-room').filter({ hasText: '察微' }).click();
  await page.getByRole('button', { name: '成员独立任务', exact: true }).click();
  assert.equal(await page.locator('.tm-job-item').count(), 0, 'private room does not receive group jobs');
  assert.deepEqual(errors, []);
  console.log('PASS browser: @everyone, four recipients, confirm-before-execute, member approval, @user report, no main transfer, concurrent chat, independent cancel, private jobs, English, 360px and both themes; no page errors.');
} finally { service.dispose(); await service.drainMemberJobs(); await browser.close(); connections.forEach(res => res.end()); await server.close(); }

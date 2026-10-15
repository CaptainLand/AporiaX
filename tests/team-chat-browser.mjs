import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { createTeamChatService } from '../electron/team-chat/service.js';
import { defaultRoleSettings } from '../shared/professional-roles.js';

await mkdir('.tmp/qa', { recursive: true });
const root = await mkdtemp(resolve('.tmp/team-browser-')), connections = new Set();
const task = { id: 'demo', title: '演示页面', workspacePath: 'D:/Demo/Team', messages: [{ role: 'user', content: '整理演示页面' }, { role: 'assistant', status: 'completed', runId: 'run', subagents: [{ agentId: 'review-1', profileId: 'review', status: 'completed', task: '检查布局', summary: '12 项检查通过。' }] }] };
const settings = defaultRoleSettings(); let calls = 0, hold = false;
const service = createTeamChatService({ dataDirectory: root, loadTask: async id => id === 'demo' ? task : { ...task, id: 'another', title: '演示任务二' },
  loadTasks: async () => [task, { ...task, id: 'another', title: '演示任务二' }], loadRoles: async () => settings,
  resolveProvider: async () => ({ id: 'demo', models: [{ id: 'mock' }] }),
  publish: event => connections.forEach(res => res.write('data: ' + JSON.stringify(event) + '\n\n')),
  callProvider: async ({ onEvent, signal }) => {
    calls++;
    if (hold) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    onEvent({ type: 'response.delta', delta: '我查看了工作记录，' });
    await new Promise(resolve => setTimeout(resolve, 180));
    onEvent({ type: 'response.delta', delta: '布局检查已经完成。可以聊聊下一步的想法。' });
    return { message: { content: '演示回复' }, usage: { total_tokens: 42, prompt_tokens: 30, completion_tokens: 12 } };
  },
});
function configureTeamServer(server) {
server.middlewares.use('/__team-events', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.write(': connected\n\n'); connections.add(res); req.on('close', () => connections.delete(res)); });
server.middlewares.use('/__team-test', async (req, res) => {
  try { let raw = ''; for await (const chunk of req) raw += chunk; const result = await service.request(JSON.parse(raw)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); }
  catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); }
});
}
const server = await createServer({ plugins: [{ name: 'team-chat-test-api', configureServer: configureTeamServer }], server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const probe = await fetch(server.resolvedUrls.local[0] + '__team-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'list', taskId: 'demo' }) });
assert.equal(probe.status, 200, 'test API must run before Vite fallback');
assert((await probe.json()).rooms.length > 0);
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1040, height: 920 }, reducedMotion: 'reduce' }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000);
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/team-chat.html');
  await page.locator('.tm-room').first().waitFor().catch(async error => { console.log('Fixture state:', await page.locator('body').innerText(), errors); throw error; }); assert.equal(calls, 0);
  assert.equal(await page.getByRole('textbox', { name: '搜索角色和会话' }).count(), 0, 'search stays behind its icon');
  assert.equal(await page.locator('.tm-room time, .tm-room-text i').count(), 0, 'list shows only avatars, names, previews and unread');
  assert.deepEqual(await page.locator('.tm-room-text b').allTextContents(), ['工作群', 'AporiaX', '探奇', '察微', '验准', '知序', '搭匠']);
  await page.waitForFunction(() => [...document.querySelectorAll('.tm-room > .agent-avatar img')].length === 6 && [...document.querySelectorAll('.tm-room img')].every(image => image.complete && image.naturalWidth > 0));
  assert.equal(await page.locator('.tm-room .agent-team-avatar img').count(),6,'Group portrait includes all six approved characters');
  await page.evaluate(() => window.fixture.language('en'));
  assert.deepEqual(await page.locator('.tm-room-text b').allTextContents(), ['Team group', 'AporiaX', 'Scout', 'Sentry', 'Checko', 'Index', 'Forge']);
  await page.evaluate(() => window.fixture.language('zh-CN'));
  const openMessage = async (selector) => {
    const message = page.locator(selector);
    await message.hover();
    await message.getByRole('button', { name: '消息选项' }).click();
  };
  const transferMessage = async () => { await openMessage('.tm-user'); await page.getByRole('button', { name: '转为工作要求', exact: true }).click(); };
  const setContext = async id => {
    await page.getByRole('button', { name: '聊天设置', exact: true }).click();
    await page.getByRole('combobox', { name: '选择工作背景' }).selectOption(id);
    await page.getByRole('button', { name: '关闭弹窗' }).click();
  };
  await page.getByRole('button').filter({ hasText: '工作群' }).click();
  const input = page.getByRole('textbox', { name: '团队聊天消息' });
  await input.fill('大家进展怎么样'); await page.getByRole('button', { name: '发送团队消息' }).click();
  await page.locator('.tm-assistant[data-status="completed"]').waitFor(); assert.equal(calls, 1);
  assert.equal(await page.locator('.tm-sender').innerText(), 'AporiaX', 'Chinese chat also uses the product name');
  await page.evaluate(() => window.fixture.language('en'));
  assert.equal(await page.locator('.tm-sender').innerText(), 'AporiaX', 'stored Chinese sender is localized without changing the message');
  await page.evaluate(() => window.fixture.language('zh-CN'));
  assert.equal(await page.getByRole('combobox', { name: '选择工作背景' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '侧聊模型' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '工作依据与用量' }).count(), 0);
  assert.equal(await page.locator('.tm-history time').count(), 0);
  assert.equal(await page.locator('.tm-assistant > .tm-avatar').count(), 1);
  await openMessage('.tm-assistant');
  assert.equal(await page.locator('.tm-message-identity .agent-avatar').getAttribute('data-avatar'),'main','Message details use the sender portrait');
  await page.getByRole('button', { name: '工作依据与用量' }).click();
  await page.getByRole('dialog').waitFor(); assert.match(await page.getByRole('dialog').innerText(), /42/);
  assert.equal(await page.locator('.tm-evidence-heading .agent-avatar').getAttribute('data-avatar'),'review','Evidence roleId resolves to the correct Sentry portrait');
  await page.screenshot({path:'.tmp/qa/team-info-portraits.png'});
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await transferMessage();
  assert.equal(await page.evaluate(() => window.fixture.transfers.length), 0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await transferMessage();
  await page.getByRole('textbox', { name: '工作要求', exact: true }).fill('请主管安排下一步');
  await page.getByRole('button', { name: '确认交给主管' }).click();
  assert.deepEqual(await page.evaluate(() => window.fixture.transfers), ['请主管安排下一步']);
  await page.getByRole('button', { name: '邀请角色' }).click();
  const reviewer = settings.profiles.find(r => r.id === 'review').name;
  await page.getByRole('group', { name: '选择回复角色' }).getByRole('button', { name: reviewer, exact: true }).click();
  await input.fill('帮我解释一下审查结果');
  await page.getByRole('button', { name: '发送团队消息' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tm-assistant[data-status="completed"]').length === 2); assert.equal(calls, 2);
  assert.match(await page.locator('.tm-assistant').last().innerText(), new RegExp(reviewer));
  await page.screenshot({ path: '.tmp/qa/team-chat-group-light.png' });
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await page.locator('.tm-room').filter({ hasText: reviewer }).first().click();
  await page.locator('.tm-empty h3').waitFor();
  assert.equal(await page.locator('.tm-message').count(), 0, 'private chat has no group history');
  await input.fill('你好'); await page.getByRole('button', { name: '发送团队消息' }).click();
  await page.locator('.tm-assistant[data-status="completed"]').waitFor(); assert.equal(calls, 3);
  assert.equal(await page.locator('.tm-sender').count(), 0, 'private chat does not repeat its recipient title');
  const geometry = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    geometry.push(await page.locator('.tm-compose').boundingBox());
    await page.screenshot({ path: `.tmp/qa/team-chat-${theme}.png` });
  }
  assert.deepEqual(geometry[0], geometry[1], 'theme geometry must remain identical');
  await setContext('another');
  await openMessage('.tm-user');
  assert.equal(await page.getByRole('button', { name: '转为工作要求', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await setContext('demo');
  await page.getByRole('button', { name: '聊天设置', exact: true }).click();
  await page.getByRole('button', { name: '侧聊模型' }).click();
  await page.getByRole('dialog', { name: '选择侧聊模型', exact: true }).waitFor();
  await page.getByRole('dialog', { name: '选择侧聊模型', exact: true }).getByRole('option').first().click();
  assert.equal(await page.getByRole('button', { name: '侧聊模型' }).getAttribute('aria-expanded'), 'false');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByRole('button', { name: '聊天设置', exact: true }).evaluate(e => e === document.activeElement), true);
  const compactHeight = (await input.boundingBox()).height;
  await input.fill('第一行\n第二行\n第三行');
  assert((await input.boundingBox()).height > compactHeight, 'pill composer grows for multiline messages');
  await input.fill('');
  assert.equal((await input.boundingBox()).height, compactHeight, 'composer shrinks again');
  hold = true; await input.fill('等待中的问题'); await page.getByRole('button', { name: '发送团队消息' }).click();
  await page.getByRole('button', { name: '停止聊天回复' }).click();
  await page.waitForFunction(() => document.querySelector('.tm-history')?.textContent.includes('已停止聊天回复'));
  hold = false;
  await page.evaluate(() => { document.getElementById('test-pane').style.width = '360px'; });
  assert.equal(await page.locator('.team-chat').evaluate(e => e.scrollWidth <= e.clientWidth), true);
  assert.equal(await page.locator('.tm-history').evaluate(e => e.scrollWidth <= e.clientWidth), true);
  await page.locator('.tm-user .tm-message-more').first().focus();
  assert.equal(await page.locator('.tm-user .tm-message-more').first().evaluate(e => getComputedStyle(e).opacity), '1');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: '消息选项', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await page.screenshot({ path: '.tmp/qa/team-chat-list-dark.png' });
  await page.getByRole('button', { name: '搜索会话', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索角色和会话' }).fill(reviewer);
  assert.equal(await page.locator('.tm-room').count(), 1);
  await page.getByRole('textbox', { name: '搜索角色和会话' }).press('Escape');
  assert.equal(await page.getByRole('textbox', { name: '搜索角色和会话' }).count(), 0);
  await page.reload(); await page.locator('.tm-room').first().waitFor();
  await page.locator('.tm-room').filter({ hasText: reviewer }).first().click();
  await page.locator('.tm-message').first().waitFor();
  assert.equal(calls, 4, 'reload does not invoke models');
  assert.deepEqual(errors, []);
  console.log('PASS browser + real service: minimal list and bubbles, hidden settings/metadata, keyboard menus, model selection in dialog, multiline composer, group default and @, private isolation, streamed output, evidence, confirmed handoff, stop, history reload, theme parity and 360px panel.');
} finally { service.dispose(); await browser.close(); connections.forEach(res => res.end()); await server.close(); }

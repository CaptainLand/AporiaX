import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { createTemporarySideChatService } from '../electron/side-chat/temporary-service.js';

const data = await mkdtemp(join(tmpdir(), 'aporia-temp-chat-ui-')), clients = new Set();
let inference = 0;
const service = createTemporarySideChatService({ dataDirectory: data,
  loadTask: async id => ({ id, workspacePath: '', permission: 'read-only', providerId: 'fixture', modelId: 'deepseek-v4-flash', messages: [] }),
  resolveProvider: async () => ({ id: 'fixture', models: [{ id: 'deepseek-v4-flash', supportsTools: true }] }),
  publish: event => { for (const client of clients) client.write('data: ' + JSON.stringify(event) + '\n\n'); },
  execute: async request => {
    inference++;
    request.onEvent({ type: 'response.delta', delta: '已理解这条临时要求。' });
    if (request.messages.at(-1).content === '等待关闭') await new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' })), { once: true });
    });
    if (request.messages.at(-1).content === '需要审批') await request.requestApproval({ title: '临时检查审批', command: 'node --check demo.js', kind: 'execute' });
    await new Promise(resolve => setTimeout(resolve, 150));
    const witness = { status: 'completed', phase: 'completed', completion: 100, progress: 100, percent: 100,
      records: [{ id: 'read-own', kind: 'tool', eventType: 'tool.completed', tool: 'read_file', status: 'completed', path: 'demo.js', detail: '检查了当前文件，未运行浏览器。', elapsedMs: 12 }], agents: [], alerts: [] };
    request.onEvent({ type: 'witness.updated', witness });
    return { status: 'completed', content: '临时分支已检查代码。\n\n```js\nconst coast = true;\n```\n\n未运行浏览器，动画效果仍需验证。', witness, changes: [], steps: [] };
  } });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null }, plugins: [{ name: 'temporary-fixture', configureServer(dev) {
  dev.middlewares.use('/__temporary/events', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.write(': ready\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); });
  dev.middlewares.use('/__temporary/request', async (req, res) => {
    try { let body = ''; for await (const chunk of req) body += chunk; const result = await service.request(JSON.parse(body)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); }
    catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
} }] });
let browser;
try {
  await server.listen(); browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/temporary-chat.html');
  await page.getByRole('button', { name: '打开临时聊天', exact: true }).click();
  const pane = page.getByRole('region', { name: '临时聊天', exact: true }); await pane.getByRole('textbox', { name: '任务输入', exact: true }).waitFor(); assert.equal(inference, 0);
  assert.equal(await pane.locator('.side-chat-heading, .temporary-chat-details, .temporary-chat-empty').count(), 0);
  assert.equal(await pane.getByRole('button', { name: '关闭临时聊天', exact: true }).count(), 0);
  assert.equal(await pane.locator('.temporary-chat-scroll').textContent(), '');
  const temporaryTab = page.getByRole('tab').filter({ hasText: '临时聊天' });
  assert((await temporaryTab.boundingBox()).width >= 120, 'temporary tab should have a roomier minimum width');
  const original = await page.evaluate(() => window.wb.draft('temporary:sessionId'));
  await pane.getByRole('button', { name: '添加内容', exact: true }).click();
  await pane.getByRole('option').filter({ hasText: '添加电脑文件' }).waitFor();
  assert.equal(await pane.getByRole('option').filter({ hasText: /Skills|MCP|工作台/ }).count(), 0);
  await pane.getByRole('textbox', { name: '任务输入', exact: true }).press('Escape');
  await pane.getByRole('textbox', { name: '任务输入', exact: true }).fill('分析海岸动画'); await pane.getByRole('button', { name: '发送', exact: true }).click();
  await pane.getByText('未运行浏览器，动画效果仍需验证。', { exact: true }).waitFor();
  assert.equal(await pane.locator('.composer').count(), 1); assert.equal(await pane.locator('.message-list').count(), 1); assert.equal(await pane.locator('.witness-panel').count(), 1);
  assert((await pane.getByRole('button', { name: '选择模型', exact: true }).textContent()).trim(), 'shared model button must have a visible label');
  assert.equal(await pane.locator('.code-block').count(), 1); assert.equal(await pane.locator('.professional-agent-panel').count(), 0);
  await mkdir('.tmp/temporary-chat-qa', { recursive: true }); await page.screenshot({ path: '.tmp/temporary-chat-qa/light.png' });
  await page.getByRole('button', { name: '切换主题' }).click(); await page.screenshot({ path: '.tmp/temporary-chat-qa/dark.png' });
  await pane.getByRole('textbox', { name: '任务输入', exact: true }).fill('尚未发送的临时草稿');
  await page.evaluate(() => window.wb.collapse()); await page.getByRole('button', { name: '打开临时聊天', exact: true }).click();
  await pane.getByText('未运行浏览器，动画效果仍需验证。', { exact: true }).waitFor(); assert.equal(await page.evaluate(() => window.wb.draft('temporary:sessionId')), original);
  assert.equal(await pane.getByRole('textbox', { name: '任务输入', exact: true }).inputValue(), '尚未发送的临时草稿');
  await pane.getByRole('textbox', { name: '任务输入', exact: true }).fill('需要审批'); await pane.getByRole('button', { name: '发送', exact: true }).click();
  await pane.getByText('临时检查审批', { exact: true }).waitFor();
  await pane.getByRole('button', { name: '本次允许', exact: true }).click();
  await pane.getByRole('button', { name: '停止当前任务' }).waitFor({ state: 'detached' });
  const ticks = Number(await page.locator('#ticks').textContent());
  await pane.getByRole('textbox', { name: '任务输入', exact: true }).fill('等待关闭'); await pane.getByRole('button', { name: '发送', exact: true }).click();
  await pane.getByRole('button', { name: '停止当前任务' }).waitFor(); await page.getByRole('tab').filter({ hasText: '临时聊天' }).getByRole('button', { name: '关闭标签', exact: true }).click();
  await pane.waitFor({ state: 'detached' }); assert(Number(await page.locator('#ticks').textContent()) >= ticks);
  await page.getByRole('button', { name: '打开临时聊天', exact: true }).click(); await pane.getByRole('textbox', { name: '任务输入', exact: true }).waitFor();
  assert.notEqual(await page.evaluate(() => window.wb.draft('temporary:sessionId')), original);
  assert.equal(await pane.locator('.witness-panel').count(), 0);
  await page.setViewportSize({ width: 900, height: 800 }); await page.screenshot({ path: '.tmp/temporary-chat-qa/narrow.png' });
  assert((await temporaryTab.boundingBox()).width >= 120, 'temporary tab should keep its minimum width in a narrow sidebar');
  assert.equal(await pane.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  await page.evaluate(() => window.wb.setLayout(layout => ({ ...layout, tabs: [...layout.tabs,
    ...['route', 'workspace', 'understanding', 'browser', 'terminal', 'file', 'git', 'teamchat'].map(kind => ({ id: `width-test:${kind}`, kind, title: kind === 'file' ? 'a-very-long-filename-for-tab-width-regression.js' : kind }))] })));
  await page.getByRole('tab').filter({ hasText: 'git' }).waitFor();
  const tabWidths = await page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getBoundingClientRect().width));
  assert.equal(tabWidths.length, 9);
  assert(tabWidths.every(width => width >= 120 && width <= 180), 'all sidebar tabs should retain a 120px minimum and truncate long titles at 180px');
  await page.screenshot({ path: '.tmp/temporary-chat-qa/tabs.png' });
  assert.deepEqual(errors, []); console.log('PASS temporary UI: shared Conversation/Composer/Witness, light/dark/narrow, hide preserves, close stops and discards, main unaffected.');
} finally { service.dispose(); for (const client of clients) client.end(); await browser?.close(); await server.close(); await rm(data, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/agent-delivery.html');
  const card = page.locator('.pa-delivery'); await card.waitFor();
  assert.match(await card.innerText(), /静态审查完成/);
  const emit = event => page.evaluate(async event => {
    const { applyProfessionalAgentEvent } = await import('/src/conversation/professional-agent-events.js');
    window.progressRows = applyProfessionalAgentEvent(window.progressRows || [], event);
    window.fixture.worker(window.progressRows[0]);
  }, { agentId: 'review-1', role: 'review', ...event });
  await emit({ type: 'subagent.started', task: '检查文件的行为与边界。' });
  await emit({ type: 'subagent.response.progress', stage: 'text', outputTokens: 123, outputTokensEstimated: true });
  await card.getByRole('status').filter({ hasText: '↓ ≈123 Token' }).waitFor();
  await emit({ type: 'subagent.response.progress', stage: 'text', outputTokens: 456, outputTokensEstimated: false });
  await card.getByRole('status').filter({ hasText: '↓ 456 Token' }).waitFor();
  assert(!(await card.innerText()).includes('↑'));
  await emit({ type: 'subagent.response.recovery.status', responseId: 'fixture', state: 'waiting', attempt: 3, connection: 'closed' });
  await card.locator('h4').filter({ hasText: '等待恢复' }).waitFor();
  assert.match(await card.innerText(), /其他成员不受影响/);
  assert(!(await card.innerText()).includes('未能完成'));
  await card.getByRole('button', { name: '继续交办', exact: true }).click();
  await card.getByLabel('追加要求').fill('检查原请求，保留已有结果。');
  await card.getByRole('button', { name: '发送交办', exact: true }).click();
  await page.waitForFunction(() => window.fixture.calls.some(c => c.kind === 'steer'));
  await emit({ type: 'subagent.response.recovery.status', responseId: 'fixture', state: 'receiving', attempt: 0 });
  await card.locator('h4').filter({ hasText: '工作中' }).waitFor();
  assert(!(await card.innerText()).includes('连接已断开'));
  await emit({ type: 'subagent.response.recovery.status', responseId: 'fixture', state: 'waiting', attempt: 3, connection: 'closed' });
  await mkdir('.tmp/harness-resilience-qa', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await card.screenshot({ path: `.tmp/harness-resilience-qa/member-recovery-${theme}.png` });
  }
  await emit({ type: 'subagent.cancelled' });
  await card.locator('h4').filter({ hasText: '已停止' }).waitFor();
  assert(!(await card.innerText()).includes('长时间未收到'));
  assert.equal(await card.getByRole('button', { name: '停止此 Agent' }).count(), 0);

  // Adjacent Witness surface consumes the same worker events independently.
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/task-operation-progress.html');
  await page.locator('.witness-panel').waitFor();
  const witness = event => page.evaluate(event => window.operationProgress(event), { agentId: 'a', role: 'explore', ...event });
  await witness({ type: 'subagent.started', task: 'Read project' });
  await witness({ type: 'subagent.response.progress', stage: 'text', outputTokens: 789, outputTokensEstimated: false });
  await page.locator('.witness-panel').getByText('↓ 789 Token', { exact: true }).first().waitFor();
  await witness({ type: 'subagent.response.recovery.status', responseId: 'a-request', state: 'waiting', attempt: 3, connection: 'closed' });
  await page.locator('.witness-panel').getByText(/长时间未收到新的模型数据/).first().waitFor();
  assert.equal(await page.locator('.witness-panel').getAttribute('data-status'), 'running');
  await witness({ type: 'subagent.cancelled' });
  assert.deepEqual(errors, []);
  console.log('PASS browser: live member tokens, scoped recovery/follow-up/resume/stop, light/dark cards and Witness projection; no page errors');
} finally { await browser.close(); await server.close(); }

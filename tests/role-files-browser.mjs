import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { approvalToastCopy } from '../electron/approval-toast-state.js';
const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 }, bypassCSP: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(10000);
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/role-files.html');
  const file = page.locator('.workspace-tree button').first(), composer = page.locator('.composer textarea');
  await file.waitFor();
  await composer.fill('保留已有草稿');
  await file.click({ button: 'right' });
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value.includes('@{./中 文.txt}'));
  assert.equal(await composer.inputValue(), '保留已有草稿\n@{./中 文.txt} ');
  assert.equal(await composer.evaluate(element => element === document.activeElement), true);
  assert.equal(await page.evaluate(() => window.fixture.sent.length), 0, 'no automatic send');
  await file.focus(); await page.keyboard.press('Shift+F10');
  assert.equal(await composer.inputValue(), '保留已有草稿\n@{./中 文.txt} ', 'keyboard menu deduplicates');
  await page.evaluate(() => { window.fixture.action = 'preview'; });
  await file.click({ button: 'right' });
  await page.waitForFunction(() => window.fixture.opened.length === 1);
  assert.equal(await page.evaluate(() => window.fixture.opened[0]), '中 文.txt');
  await page.getByPlaceholder('搜索工作区文件名（最多 200 条）').fill('中');
  await page.locator('.workbench-search-hint').waitFor();
  await page.evaluate(() => { window.fixture.action = 'copy-path'; });
  await page.locator('.workspace-tree button').first().click({ button: 'right' });
  await page.waitForFunction(() => window.fixture.notices.includes('路径已复制。'));
  assert.equal((await page.evaluate(() => window.fixture.calls.at(-1))).path, '中 文.txt', 'search result shares context menu');
  await page.evaluate(() => { window.fixture.action = null; });
  await page.locator('.workspace-tree button').first().click({ button: 'right' });
  assert.equal(await page.evaluate(() => window.fixture.sent.length), 0);
  await page.evaluate(() => { window.fixture.fail = true; });
  await page.locator('.workspace-tree button').first().click({ button: 'right' });
  await page.waitForFunction(() => window.fixture.notices.includes('Fixture menu failure'));
  const approval = page.locator('.approval-card');
  assert.match(await approval.innerText(), /修改前[\s\S]*旧角色[\s\S]*修改后[\s\S]*新角色/);
  assert.equal(await approval.locator('script').count(), 0, 'instructions are text, not HTML');
  assert.equal(await approval.getByRole('button').count(), 2, 'only deny / allow once, no run-wide grant');
  await approval.getByRole('button', { name: '本次允许', exact: true }).click();
  await approval.getByRole('button', { name: '拒绝', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.fixture.decisions), [{ approved: true, scope: 'once' }, { approved: false, scope: undefined }]);
  const geometry = [];
  await mkdir('.tmp/qa', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    geometry.push(await approval.boundingBox());
    await page.screenshot({ path: `.tmp/qa/role-files-${theme}.png` });
  }
  assert.deepEqual(geometry[0], geometry[1]);
  await page.evaluate(() => { window.fixture.fail = false; window.fixture.pending = true; });
  await page.locator('.workspace-tree button').first().click({ button: 'right' });
  await page.waitForFunction(() => Boolean(window.fixture.resolveMenu));
  await page.evaluate(() => window.fixture.switchTask());
  await composer.fill('新任务的草稿');
  await page.evaluate(() => window.fixture.resolveMenu());
  assert.equal(await page.evaluate(() => window.fixture.sent.length), 0);
  assert.equal(await composer.inputValue(), '新任务的草稿', 'old task popup cannot insert into another task');
  await page.evaluate(() => window.fixture.showSimilarApproval());
  const allowSimilar = approval.getByRole('button', { name: '本轮允许类似操作', exact: true });
  await allowSimilar.waitFor();
  assert.equal(await approval.getByRole('button').count(), 3, 'separate once, similar and deny actions');
  assert.match(await approval.innerText(), /工作区根目录.+\.html.+不含子目录/);
  await allowSimilar.click();
  assert.deepEqual(await page.evaluate(() => window.fixture.decisions.at(-1)), { approved: true, scope: 'run' });
  assert.deepEqual(errors, []);

  const toast = await browser.newPage({ viewport: { width: 396, height: 236 } });
  await toast.addInitScript(() => {
    window.approvalToast = { onPayload: callback => { window.toastPayload = callback; }, decide: (...args) => { window.toastDecision = args; } };
  });
  await toast.goto(server.resolvedUrls.local[0] + 'electron/approval-toast.html');
  const details = { canRememberForRun: true, similarApproval: { kind: 'delete-file', directory: 'output'.repeat(7), extension: '.html' }, command: 'delete_file ' + 'x '.repeat(80) };
  for (const [language, theme] of [['zh-CN', 'light'], ['en', 'dark']]) {
    await toast.evaluate(payload => window.toastPayload(payload), { ...approvalToastCopy(details, language), theme });
    const action = toast.locator('#similar');
    const box = await action.boundingBox();
    assert(box && box.x + box.width <= 396 && box.y + box.height <= 236, `${language} window size fits all approval options: ${JSON.stringify(box)}`);
    await action.click();
    assert.deepEqual(await toast.evaluate(() => window.toastDecision), [true, 'run']);
  }
  await toast.evaluate(payload => window.toastPayload(payload), approvalToastCopy({ kind: 'agent-role-change' }));
  assert.equal(await toast.locator('#similar').isVisible(), false);
  console.log('PASS browser: file interactions, once-only role changes, similar approvals in the chat card and toast.');
} finally { await browser.close(); await server.close(); }

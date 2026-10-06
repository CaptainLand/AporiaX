import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer, preview } from 'vite';
import { chromium } from 'playwright-core';
const baseline = process.argv.includes('--baseline');
const production = process.argv.includes('--production');
const server = production ? await preview({ preview: { host: '127.0.0.1', port: 0, open: false } })
  : await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
if (!production) await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, bypassCSP: !production });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('aporiax.language.v1', 'zh-CN'); localStorage.setItem('aporiax.theme.v2', 'light');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'composer-alignment', welcomeDismissed: true }));
    const task = { id: 'composer-alignment', title: '输入框对齐测试', workspaceName: 'Fixture', workspacePath: 'D:/Fixture',
      providerId: 'own', modelId: 'model', createdAt: '2026-10-06T00:00:00Z', messages: [
        { id: 'user', role: 'user', content: '合成任务，不发送模型请求' },
        { id: 'answer', role: 'assistant', status: 'completed', content: ('用于检查滚动到底时 Witness 与输入框之间的距离。\n\n').repeat(30),
          witness: { status: 'completed', startedAt: 1791230000000, revision: 1, counters: { activeAgents: 0 }, records: [
            { id: 'start', kind: 'lifecycle', title: 'Witness 开始记录', status: 'completed', startedAt: 1791230000000, endedAt: 1791230000000 },
            { id: 'model', kind: 'thinking', title: '主 Agent 模型响应阶段', status: 'completed', startedAt: 1791230000000, endedAt: 1791230005000 },
            { id: 'done', kind: 'lifecycle', title: '任务执行完成', status: 'completed', startedAt: 1791230005000, endedAt: 1791230005000 },
          ] } },
      ] };
    window.alignmentCalls = [];
    const harnessListeners = new Set();
    let activeRun = null;
    window.desktop = {
      theme: { set: async () => {} }, providers: { list: async () => [{ id: 'own', name: 'Fixture', models: [{ id: 'model', name: 'Fixture model' }] }] },
      account: { get: async () => ({ status: 'anonymous' }) }, tasks: { load: async () => [task], save: async () => {} },
      harness: { onEvent: listener => { harnessListeners.add(listener); return () => harnessListeners.delete(listener); }, recoverableRuns: async () => [],
        run: async request => { activeRun = { runId: request.runId, taskId: request.taskId, assistantId: request.assistantId }; window.alignmentStartedRuns = (window.alignmentStartedRuns || 0) + 1; return new Promise(resolve => { window.completeAlignmentRun = () => resolve({ status: 'completed', content: '合成运行已结束。', steps: [], changes: [], witness: { status: 'completed', records: [], counters: { activeAgents: 0 }, startedAt: 1791230005000 } }); }); },
        pause: async () => { for (const listener of harnessListeners) listener({ ...activeRun, type: 'control.paused', pauseReasons: ['user'] }); return true; },
        resume: async () => { for (const listener of harnessListeners) listener({ ...activeRun, type: 'control.resumed', pauseReasons: [] }); return true; },
      }, sandbox: { status: async () => ({ localAvailable: true }) },
      workspace: { listTree: async () => ({ entries: [] }) },
      workbench: { subscribe: () => () => {}, request: async input => { window.alignmentCalls.push(input); return input.action === 'list' ? [] : true; } },
      sideChat: { subscribe: () => () => {}, request: async input => { window.alignmentCalls.push(input); return { messages: [{ id: 'side-answer', role: 'assistant', status: 'completed', content: '合成侧聊历史。\n\n'.repeat(10) }] }; } },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.witness-panel').waitFor();
  await page.getByRole('button', { name: '打开工作侧栏', exact: true }).click();
  await page.getByRole('button', { name: '打开内容', exact: true }).click();
  await page.getByRole('menuitem', { name: '侧边聊天', exact: true }).click();
  const mainInput = page.getByRole('textbox', { name: '任务输入', exact: true });
  const sideInput = page.getByRole('textbox', { name: '侧聊输入', exact: true });
  await sideInput.waitFor();
  await page.waitForFunction(() => !document.querySelector('.side-chat-modes button')?.disabled);
  const atBottom = () => page.evaluate(() => { const body = document.querySelector('.thread-body'); body.scrollTop = body.scrollHeight; });
  const measure = () => page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
    const main = rect('.composer'), side = rect('.side-chat-composer'), witness = rect('.witness-panel'), body = rect('.thread-body');
    return { theme: document.documentElement.dataset.theme, main, side, witness,
      witnessGap: main.top - Math.min(witness.bottom, body.bottom), bottomDelta: side.bottom - main.bottom,
      mainTextHeight: rect('.composer textarea').height, sideTextHeight: rect('.side-chat-composer textarea').height };
  });
  await mkdir('.tmp/qa', { recursive: true });
  const check = async label => {
    await atBottom(); await page.waitForTimeout(100); const result = await measure();
    if (baseline) assert.ok(Math.abs(result.bottomDelta) >= 15, 'Reproduce old bottom-edge mismatch');
    else {
      assert.ok(Math.abs(result.main.top - result.side.top) < 1, `${label}: top edges align ${JSON.stringify(result)}`);
      assert.ok(Math.abs(result.bottomDelta) < 1, `${label}: bottom edges align`);
      assert.ok(Math.abs(result.main.height - result.side.height) < 1, `${label}: input heights match`);
      assert.ok(result.witnessGap >= 9 && result.witnessGap <= 45, `${label}: Witness has a small visible gap (${result.witnessGap})`);
    }
    console.log(`${baseline ? 'BASELINE' : 'PASS'} ${label}: ${JSON.stringify(result)}`);
    await page.screenshot({ path: `.tmp/qa/composer-alignment-${baseline ? 'baseline-' : production ? 'production-' : ''}${label}.png` });
    return result;
  };
  const light = await check('light'); await page.locator('.theme-toggle').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark'); const dark = await check('dark');
  assert.equal(light.main.height, dark.main.height); assert.equal(light.side.height, dark.side.height);
  if (!baseline) {
    const draft = Array.from({ length: 5 }, (_, i) => `草稿第 ${i + 1} 行`).join('\n');
    await mainInput.fill(draft); await sideInput.fill(draft); await page.waitForTimeout(100);
    const expanded = await measure();
    assert.ok(expanded.main.height > light.main.height); assert.equal(expanded.main.height, expanded.side.height);
    assert.equal(await mainInput.inputValue(), draft); assert.equal(await sideInput.inputValue(), draft);
    await mainInput.fill(''); await sideInput.fill(''); await page.waitForTimeout(100);
    assert.equal((await measure()).main.height, light.main.height);
    await page.setViewportSize({ width: 1000, height: 620 }); await check('compact-dark');
    console.log('PASS multiline auto-grow/shrink, draft retention and compact viewport; no extra model requests.');
    await mainInput.fill('合成运行：只测试状态提示，不调用任何模型'); await mainInput.press('Enter');
    await page.locator('.composer-hint').filter({ hasText: '任务运行中' }).waitFor();
    await page.waitForFunction(() => window.alignmentStartedRuns === 1);
    await check('running-status');
    await page.getByRole('button', { name: '暂停当前任务', exact: true }).click();
    await page.locator('.composer-hint').filter({ hasText: '任务已暂停' }).waitFor();
    await check('paused-status');
    await page.evaluate(() => window.completeAlignmentRun());
    await page.waitForFunction(() => !document.querySelector('.composer-hint'));
    await page.waitForTimeout(100);
    const cleared = await measure(); assert.ok(Math.abs(cleared.bottomDelta) < 1);
    assert.equal(await page.locator('.task-workspace').evaluate(el => el.style.getPropertyValue('--main-composer-status-space')), '0px');
    console.log('PASS running/paused/wrapped status notices align both boxes; completion clears status spacing. Synthetic harness only.');
  }
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.alignmentCalls.some(c => ['send', 'commit', 'push'].includes(c.action || c.operation))), false);
} finally { await browser.close(); await server.httpServer.close(); }

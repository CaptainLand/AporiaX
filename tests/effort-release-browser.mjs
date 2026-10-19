import assert from 'node:assert/strict';
import { createServer, preview } from 'vite';
import { chromium } from 'playwright-core';

const production = process.argv.includes('--production');
const measureOnly = process.argv.includes('--measure-only');
// Optional comparison against the previous eager Markdown parsing, without
// changing source files or touching a real task/account.
const unmemoized = process.argv.includes('--unmemoized');
assert(!production || !unmemoized, 'the comparison transform is dev-only');
const server = production ? await preview({ preview: { host: '127.0.0.1', port: 0, open: false } })
  : await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null }, plugins: [{
    name: 'markdown-release-cost', enforce: 'pre',
    transform: { order: 'pre', handler(source, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/conversation/ConversationViews.jsx')) return;
      if (unmemoized) {
        const previous = source;
        source = source.replace('const MarkdownMessage = React.memo(function MarkdownMessage({ content }) {', 'function MarkdownMessage({ content }) {')
          .replace(/\}\);(\r?\n\r?\nfunction MessageImage)/, '}$1');
        if (source === previous) throw new Error('Comparison transform did not match MarkdownMessage');
      }
      return source.replace('function MarkdownMessage({ content }) {', 'function MarkdownMessage({ content }) { window.markdownParses = (window.markdownParses || 0) + 1;');
    } },
  }] });
if (!production) await server.listen();
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = server.resolvedUrls.local[0];
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.theme.v2', 'dark');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'release', welcomeDismissed: true }));
    const block = '### 检查结果\n\n一段较长的历史答复，调整思考强度不应重新解析这些文字。\n\n| 项目 | 状态 |\n| --- | --- |\n| 页面 | 通过 |\n| 交互 | 通过 |\n\n```js\nconst ready = true;\n```\n\n';
    const task = { id: 'release', title: '长对话滑条测试', workspacePath: 'D:/Fixture', workspaceName: 'Fixture', providerId: 'own', modelId: 'claude-opus-5-5', effort: 'high', messages: Array.from({ length: 16 }, (_, i) => ({ id: `m${i}`, role: 'assistant', status: 'completed', content: `${i}\n\n${block.repeat(12)}` })) };
    window.releaseSaves = 0;
    window.desktop = {
      theme: { set: async () => {} }, account: { get: async () => ({ status: 'anonymous' }) },
      providers: { list: async () => [{ id: 'own', name: 'Fixture', models: [{ id: task.modelId, name: 'Claude Opus 5.5', shortName: 'Opus 5.5', supportsThinking: true }] }] },
      tasks: { load: async () => [task], save: async tasks => { window.releaseSaves++; window.releaseTask = tasks[0]; return true; } },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] }, sandbox: { status: async () => ({ localAvailable: true }) },
      workspace: { listTree: async () => ({ entries: [] }) }, workbench: { subscribe: () => () => {}, request: async () => true },
    };
  });
  await page.goto(base);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.assistant-message').first().waitFor();
  await page.getByRole('button', { name: '切换思考强度', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '思考强度', exact: true });
  const slider = menu.getByRole('slider');
  await page.waitForFunction(() => document.querySelector('.effort-gem')?.dataset.state === 'animated');
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const taskTime = async () => (await session.send('Performance.getMetrics')).metrics.find(metric => metric.name === 'TaskDuration').value * 1000;
  const bounds = await slider.boundingBox();
  const y = bounds.y + bounds.height / 2;
  const initialParses = await page.evaluate(() => window.markdownParses);
  if (!production) assert(initialParses > 0, 'parse counter is active');
  const samples = [];
  for (const progress of [1, .25, 1]) {
    await page.mouse.move(bounds.x + 17 + (bounds.width - 30) * progress, y);
    await page.mouse.down();
    // Complete the local preview before measuring the commit on release.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await taskTime();
    await page.mouse.up();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    samples.push(Math.round((await taskTime()) - before));
  }
  assert.equal(await slider.getAttribute('aria-valuetext'), 'Max');
  const extraParses = await page.evaluate(initial => window.markdownParses - initial, initialParses);
  if (!production && !measureOnly) assert.equal(extraParses, 0, 'effort-only commits reuse the parsed history');
  // A repeated Max selection must not publish another task-store snapshot/save.
  await page.waitForFunction(() => window.releaseTask?.effort === 'max');
  await page.waitForTimeout(800);
  const savesBefore = await page.evaluate(() => window.releaseSaves);
  await page.mouse.move(bounds.x + bounds.width - 2, y);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(850);
  const duplicateSaves = await page.evaluate(before => window.releaseSaves - before, savesBefore);
  if (!measureOnly) assert.equal(duplicateSaves, 0, 'releasing on the current level does not update or save the entire task');
  assert.equal(await page.locator('.markdown-message').count(), 16, 'history is retained');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ releaseTaskMs: samples, extraParses: production ? null : extraParses, duplicateSaves, production, unmemoized }));
} finally {
  await browser?.close();
  await server.httpServer.close();
}

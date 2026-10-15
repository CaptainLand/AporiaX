import assert from 'node:assert/strict';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { defaultAppearance, PRESET_COLORS, validateTheme } from '../shared/appearance.js';

// Exercise the built application without capturing screenshots or contacting
// accounts, models, or real workspaces.
const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
let browser;
try {
  const base = server.resolvedUrls.local[0];
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  for (const mode of ['light', 'dark', 'custom-light', 'custom-dark']) {
    const theme = mode.endsWith('dark') ? 'dark' : 'light';
    const appearance = defaultAppearance();
    if (mode.startsWith('custom')) {
      const id = 'theme-00000000-0000-4000-8000-000000000001';
      const draft = validateTheme({ name: 'Surface test', base: theme, colors: { ...PRESET_COLORS[theme], ...(theme === 'dark' ? { background: '#0a1410', panel: '#12201a', text: '#e6f2e8', accent: '#31c48d' } : { background: '#fffdf7', panel: '#f1eee5', text: '#292820', accent: '#74602a' }) } });
      Object.assign(appearance, { enabled: true, selectedId: id, base: theme, themes: [{ ...draft, id, source: 'manual', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' }] });
    }
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await context.addInitScript(({ theme, appearance }) => {
      localStorage.clear();
      localStorage.setItem('aporiax.language.v1', 'zh-CN');
      localStorage.setItem('aporiax.theme.v2', theme);
      localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ welcomeDismissed: true, taskId: 'flat-demo' }));
      const at = '2026-10-15T00:00:00Z';
      const records = Array.from({ length: 5 }, (_, i) => ({ id: 'record-' + i, kind: 'tool', tool: 'read_file', title: '读取文件', path: 'demo-' + i + '.md', status: 'completed', startedAt: at, elapsedMs: 10 }));
      const task = { id: 'flat-demo', title: '样式检查', workspaceName: '演示工作区', workspacePath: 'D:/Demo/Starlight', providerId: 'demo-api', modelId: 'demo-model', messages: [
        { id: 'u', role: 'user', content: '检查演示页面。', createdAt: at },
        { id: 'a', role: 'assistant', status: 'completed', createdAt: at, content: '## 检查结果\n\n| 检查项 | 结果 |\n| --- | --- |\n| 页面 | 通过 |\n\n```js\nconst demo = true;\n```', changes: [{ path: 'demo.js', beforeContent: 'old\n', afterContent: 'new\n', additions: 1, deletions: 1 }], witness: { status: 'completed', startedAt: at, records, counters: { toolCalls: 5, fileChanges: 1, activeAgents: 0 } } },
      ] };
      window.desktop = {
        theme: { set: async () => {} }, appearance: { request: async () => appearance },
        account: { get: async () => ({ status: 'anonymous' }) },
        providers: { list: async () => [{ id: 'demo-api', name: '演示 API', baseUrl: 'https://example.invalid/v1', protocol: 'chat-completions', hasApiKey: true, models: [{ id: 'demo-model', name: '演示模型' }] }] },
        tasks: { load: async () => [task], save: async () => {} },
        harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
        sandbox: { status: async () => ({ localAvailable: true }) },
        workbench: { request: async ({ action }) => action === 'list' ? [] : true, subscribe: () => () => {} },
      };
    }, { theme, appearance });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
    if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
    await page.locator('.witness-panel').waitFor();
    if (mode.startsWith('custom')) await page.waitForFunction(() => Boolean(document.documentElement.dataset.customTheme));
    for (const selector of ['.markdown-message table', '.code-block', '.edited-files-card', '.witness-panel']) {
      const surface = page.locator(selector).first();
      assert.equal(await surface.count(), 1, selector);
      const style = await surface.evaluate(el => {
        const s = getComputedStyle(el);
        const probe = document.createElement('span'); probe.style.backgroundColor = 'var(--gray-2)'; el.append(probe);
        const fill = getComputedStyle(probe).backgroundColor; probe.remove();
        return { shadow: s.boxShadow, blur: s.backdropFilter, webkitBlur: s.webkitBackdropFilter, bg: s.backgroundColor, fill };
      });
      assert.equal(style.shadow, 'none', `${mode} ${selector} shadow`);
      assert.equal(style.blur, 'none', `${mode} ${selector} blur`);
      assert.ok(!style.webkitBlur || style.webkitBlur === 'none');
      assert.equal(style.bg, style.fill, `${mode} ${selector} theme fill`);
    }
    const toggle = page.locator('.witness-toggle');
    assert.equal(await page.locator('.witness-record').count(), 3);
    await toggle.click(); assert.equal(await page.locator('.witness-record').count(), 5);
    await toggle.click(); assert.equal(await page.locator('.witness-record').count(), 3);
    await toggle.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
    assert.notEqual(await toggle.evaluate(el => getComputedStyle(el).outlineStyle), 'none', 'keyboard focus retained');
    await page.locator('.review-files-button').click();
    await page.locator('.review-panel').waitFor();
    await page.getByRole('button', { name: '关闭审核', exact: true }).click();
    await page.getByRole('button', { name: '打开 AporiaX 设置', exact: true }).click();
    // Compare visible paper colors, including transparent ancestors.
    const paper = locator => locator.evaluate(el => {
      while (el) { const color = getComputedStyle(el).backgroundColor; if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color; el = el.parentElement; }
      return null;
    });
    const general = await paper(page.locator('.application-settings-content'));
    await page.locator('.application-settings-nav').getByRole('button', { name: '模型与 API', exact: true }).click();
    await page.locator('.provider-workbench').waitFor();
    for (const selector of ['.provider-workbench', '.provider-workbench > .modal-footer', '.provider-editor']) {
      assert.equal(await paper(page.locator(selector)), general, `${mode} shared settings background: ${selector}`);
    }
    assert.equal(await page.locator('.provider-workbench').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.getByRole('button', { name: '新增 API', exact: true }).click();
    await page.getByLabel('名称（可选）', { exact: true }).fill('新服务');
    assert.equal(await page.getByLabel('名称（可选）', { exact: true }).inputValue(), '新服务');
    assert.deepEqual(errors, [], `${mode} page errors`);
    await context.close();
    console.log(`PASS ${mode}: flat table/code/changes/Witness, expand/review/focus, shared model/settings paper.`);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}

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
  const page = await browser.newPage({ viewport: { width: 1450, height: 850 }, bypassCSP: !production });
  page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    // Every navigation is a fresh synthetic scenario, not the app's cached
    // previous task snapshot. This storage belongs only to the isolated test.
    localStorage.clear();
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.theme.v2', new URLSearchParams(location.search).get('theme') || 'light');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'theme-parity', welcomeDismissed: true }));
    const messages = [];
    for (let i = 0; i < 18; i++) {
      messages.push({ id: `u${i}`, role: 'user', content: `合成布局测试请求 ${i}` });
      messages.push({ id: `a${i}`, role: 'assistant', status: 'completed',
        content: `### 阶段 ${i}\n\n${'同一份内容在两个主题下只改变颜色，阅读位置应保持不变。 '.repeat(6)}\n\n| 项目 | 状态 | 数量 |\n| --- | --- | --- |\n| 检查一 | 完成 | \`10\` |\n| 检查二 | 完成 | 20 |\n| 检查三 | 完成 | 30 |\n\n\`\`\`js\nconst sample = true;\nconsole.log(sample);\n\`\`\``,
        changes: [{ path: `sample-${i}.js`, beforeContent: i % 2 ? 'old' : '', beforeMissing: i % 2 === 0, created: i % 2 === 0, afterContent: 'new', additions: 1, deletions: 1 }],
        selfCheck: { required: true, completed: true, reviewedFiles: [`sample-${i}.js`], summary: '合成测试记录，不执行真实命令。', verification: { required: true, passed: true, results: [{ command: 'fixture check', exitCode: 0 }] }, remainingRisks: ['合成提示'] },
      });
    }
    if (new URLSearchParams(location.search).get('themeFixture') === 'witness') {
      messages.at(-1).witness = { status: 'completed', records: [], revision: 1, counters: { activeAgents: 0 }, startedAt: 1791230000000 };
    }
    const task = { id: 'theme-parity', title: '主题布局一致性测试', workspaceName: 'Fixture', workspacePath: 'D:/Fixture',
      providerId: 'own', modelId: 'test', builderLimit: 2, createdAt: '2026-10-06T00:00:00Z', messages };
    window.themeCalls = [];
    window.desktop = {
      theme: { set: async () => {} }, providers: { list: async () => [{ id: 'own', name: 'Test', models: [{ id: 'test', name: 'Test' }] }] },
      account: { get: async () => ({ status: 'anonymous' }) }, tasks: { load: async () => new URLSearchParams(location.search).get('themeFixture') === 'empty' ? [] : [task], save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] }, sandbox: { status: async () => ({ localAvailable: true }) },
      workspace: { listTree: async () => ({ entries: [] }) },
      workbench: { subscribe: () => () => {}, request: async input => { window.themeCalls.push(input); return input.action === 'list' ? [] : true; } },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.assistant-message').nth(17).waitFor();
  // Existing UI can intentionally hide these legacy summaries; still compare
  // their computed styles so revealing one cannot reintroduce theme geometry.
  await page.locator('.self-check-card').nth(17).waitFor({ state: 'attached' });
  const measure = () => page.evaluate(() => {
    const body = document.querySelector('.thread-body');
    const fields = ['width', 'height', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'marginTop', 'marginBottom',
      'marginLeft', 'marginRight', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'borderTopWidth', 'borderBottomWidth',
      'borderLeftWidth', 'borderRightWidth', 'borderRadius', 'position', 'display', 'gap', 'rowGap', 'columnGap', 'whiteSpace', 'scrollPaddingTop', 'scrollPaddingBottom'];
    const selectors = ['.thread', '.thread-header', '.thread-view-tabs', '.thread-body', '.message-list', '.user-message', '.message-bubble',
      '.assistant-message', '.assistant-message-heading', '.markdown-message h3', '.markdown-message p', '.markdown-message table', '.markdown-message th', '.markdown-message td',
      '.markdown-message code', '.code-block', '.code-block-toolbar', '.edited-files-card', '.edited-files-header', '.edited-files-icon', '.edited-files-title',
      '.edited-file-list', '.edited-file-row', '.review-files-button', '.self-check-card', '.self-check-heading', '.self-check-icon', '.self-check-verification',
      '.self-check-card p', '.self-check-card details', '.witness-panel', '.witness-heading', '.witness-mark', '.witness-current',
      '.composer-shell', '.composer', '.composer textarea'];
    const styles = {};
    for (const selector of selectors) styles[selector] = [...document.querySelectorAll(selector)].map(el => {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      return { renderedHeight: r.height, renderedWidth: r.width, ...Object.fromEntries(fields.map(f => [f, cs[f]])) };
    });
    return { theme: document.documentElement.dataset.theme, scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
      anchorY: document.querySelectorAll('.assistant-message')[6].getBoundingClientRect().top - body.getBoundingClientRect().top,
      background: getComputedStyle(body).backgroundColor, scrollbarColor: getComputedStyle(body).scrollbarColor,
      scrollbarWidth: getComputedStyle(body, '::-webkit-scrollbar').width, thumbBorder: getComputedStyle(body, '::-webkit-scrollbar-thumb').borderTopWidth,
      styles };
  });
  const toggle = async () => { await page.locator('.theme-toggle').click(); await page.waitForTimeout(180); };
  const differences = (one, two) => {
    const result = [];
    for (const [selector, list] of Object.entries(one.styles)) {
      if (list.length !== two.styles[selector].length) { result.push({ selector, reason: 'element count changed' }); continue; }
      for (const [index, style] of list.entries()) for (const key of Object.keys(style)) {
        if (style[key] !== two.styles[selector][index][key]) result.push({ selector, index, key, light: style[key], dark: two.styles[selector][index][key] });
      }
    }
    return result;
  };
  await page.evaluate(() => {
    const body = document.querySelector('.thread-body'), anchor = document.querySelectorAll('.assistant-message')[6];
    body.scrollTop += anchor.getBoundingClientRect().top - body.getBoundingClientRect().top - 100;
  });
  await page.waitForTimeout(250);
  const light = await measure();
  assert.equal(light.styles['.message-list'][0].paddingTop, '35px', 'Keep established daylight geometry');
  assert.equal(light.styles['.composer-shell'][0].paddingTop, baseline ? '0px' : '10px');
  await mkdir('.tmp/qa', { recursive: true });
  await page.screenshot({ path: `.tmp/qa/theme-parity-${baseline ? 'baseline-' : production ? 'production-' : ''}light.png` });
  await toggle(); const dark = await measure();
  await page.screenshot({ path: `.tmp/qa/theme-parity-${baseline ? 'baseline-' : production ? 'production-' : ''}dark.png` });
  const diff = differences(light, dark);
  if (baseline) {
    assert.ok(diff.length > 0); assert.ok(Math.abs(dark.anchorY - light.anchorY) > 100);
    console.log(`BASELINE ${diff.length} geometry differences; reading anchor shifted ${dark.anchorY - light.anchorY}px; scroll heights ${light.scrollHeight}/${dark.scrollHeight}.`);
  } else {
    assert.equal(diff.length, 0, JSON.stringify(diff.slice(0, 16)));
    assert.equal(dark.scrollHeight, light.scrollHeight); assert.equal(dark.clientHeight, light.clientHeight);
    assert.equal(dark.scrollTop, light.scrollTop); assert.ok(Math.abs(dark.anchorY - light.anchorY) < 1);
    assert.equal(dark.scrollbarColor, light.scrollbarColor); assert.equal(dark.scrollbarWidth, light.scrollbarWidth);
    assert.equal(dark.thumbBorder, light.thumbBorder); assert.notEqual(dark.background, light.background, 'Keep dark palette');
    for (let i = 0; i < 5; i++) { await toggle(); const next = await measure(); assert.ok(Math.abs(next.anchorY - light.anchorY) < 1); assert.equal(next.scrollTop, light.scrollTop); }
    console.log(`PASS identical geometry across ${Object.values(light.styles).reduce((n, a) => n + a.length, 0)} elements; middle anchor unchanged through 6 switches.`);
    await page.evaluate(() => { const b = document.querySelector('.thread-body'); b.scrollTop = b.scrollHeight; });
    await page.waitForTimeout(180);
    const atBottom = await measure(); await toggle(); const switchedBottom = await measure();
    assert.ok(Math.abs(atBottom.scrollHeight - atBottom.clientHeight - atBottom.scrollTop) < 1);
    assert.ok(Math.abs(switchedBottom.scrollHeight - switchedBottom.clientHeight - switchedBottom.scrollTop) < 1);
    const row = page.locator('.edited-file-row').first(); await row.hover(); const hovered = await measure();
    await toggle(); const hoverOther = await measure(); assert.equal(differences(hovered, hoverOther).length, 0, 'File-row hover does not change geometry between themes');
    await page.locator('.composer textarea').fill('同一份草稿\n第二行草稿'); await page.locator('.composer textarea').focus();
    const focused = await measure(); await toggle(); const focusOther = await measure();
    assert.equal(differences(focused, focusOther).length, 0, 'Focused composer geometry remains shared');
    assert.equal(await page.locator('.composer textarea').inputValue(), '同一份草稿\n第二行草稿');
    console.log('PASS bottom stays at bottom; hovered file rows, focused multiline composer and draft remain stable.');
    await page.setViewportSize({ width: 1024, height: 700 }); await page.waitForTimeout(180);
    const narrow = await measure(); await toggle(); const narrowOther = await measure();
    assert.equal(differences(narrow, narrowOther).length, 0, 'Narrow viewport parity');
    assert.equal(narrow.scrollHeight, narrowOther.scrollHeight); assert.equal(narrow.clientHeight, narrowOther.clientHeight);
    console.log('PASS 1024px viewport layout and scrollbar proportions remain identical.');
    await page.goto(server.resolvedUrls.local[0] + '?themeFixture=witness');
    // Clearing the isolated cache also resets the ordinary welcome screen.
    if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
    await page.locator('.witness-panel').waitFor();
    const witnessLight = await measure(); await toggle(); const witnessDark = await measure();
    assert.equal(differences(witnessLight, witnessDark).length, 0, 'Witness presence cannot change theme geometry');
    assert.equal(witnessLight.scrollHeight, witnessDark.scrollHeight); assert.equal(witnessLight.clientHeight, witnessDark.clientHeight);
    await page.getByRole('button', { name: '打开工作侧栏', exact: true }).click();
    await page.locator('.workbench-chrome').waitFor();
    const splitDark = await measure(); await toggle(); const splitLight = await measure();
    assert.equal(differences(splitDark, splitLight).length, 0, 'Open side pane retains theme parity');
    assert.equal(splitDark.scrollHeight, splitLight.scrollHeight); assert.equal(splitDark.clientHeight, splitLight.clientHeight);
    console.log('PASS Witness panel and open work side pane keep identical geometry and scroll ranges.');
    await page.goto(server.resolvedUrls.local[0] + '?themeFixture=empty');
    if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
    await page.locator('.empty-state h1').waitFor();
    const emptyLayout = () => page.locator('.empty-state').evaluate(el => {
      const title = el.querySelector('h1'), cs = getComputedStyle(title), r = title.getBoundingClientRect();
      return { width: r.width, height: r.height, fontSize: cs.fontSize, fontWeight: cs.fontWeight, letterSpacing: cs.letterSpacing,
        marginTop: cs.marginTop, marginBottom: cs.marginBottom, padding: getComputedStyle(el).padding };
    });
    // Empty state has no task toolbar toggle; load the other saved theme using
    // the app's normal startup preference, rather than inventing a control.
    const emptyLight = await emptyLayout();
    await page.goto(server.resolvedUrls.local[0] + '?themeFixture=empty&theme=dark');
    if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
    await page.locator('.empty-state h1').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.deepEqual(await emptyLayout(), emptyLight);
    console.log('PASS empty main panel typography and geometry remain identical.');
  }
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.themeCalls.some(c => ['send', 'push', 'commit'].includes(c.action || c.operation))), false);
} finally { await browser.close(); await server.httpServer.close(); }

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const server = await createServer({ server: { host: '127.0.0.1', port: 0, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 400, height: 600 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await mkdir('.tmp/qa', { recursive: true });
  const url = server.resolvedUrls.local[0] + 'tests/fixtures/workbench-launcher.html';
  await page.goto(url); const cards = page.locator('.workbench-empty-card'); await cards.first().waitFor();
  if (process.argv.includes('--baseline')) {
    await page.screenshot({ path: '.tmp/qa/workbench-launcher-before.png' });
    console.log('BASELINE', await cards.first().evaluate(el => ({ height: el.offsetHeight, border: getComputedStyle(el).borderWidth, background: getComputedStyle(el).backgroundColor })));
  } else {
    for (const theme of ['dark', 'light']) {
      await page.goto(url + '?theme=' + theme); await cards.first().waitFor();
      assert.deepEqual(await cards.allTextContents().then(texts => texts.map(t => t.trim())), ['侧边聊天', '变更', '浏览器', '终端', '文件', 'Git']);
      const base = await cards.first().evaluate(el => { const css = getComputedStyle(el); return { height: el.offsetHeight, border: css.borderWidth, radius: css.borderRadius, shadow: css.boxShadow, background: css.backgroundColor, image: css.backgroundImage }; });
      assert.equal(base.height, 92); assert.equal(base.border, '0px'); assert.equal(base.radius, '14px'); assert.equal(base.shadow, 'none'); assert.equal(base.image, 'none');
      assert.deepEqual(await cards.locator('svg').evaluateAll(icons => icons.map(icon => icon.getAttribute('width'))), Array(6).fill('20'));
      await page.screenshot({ path: `.tmp/qa/workbench-launcher-${theme}.png` });
      await cards.first().hover(); await page.waitForTimeout(150);
      assert.notEqual(await cards.first().evaluate(el => getComputedStyle(el).backgroundColor), base.background);
      await page.mouse.move(1, 1); await page.keyboard.press('Tab');
      assert.equal(await cards.first().evaluate(el => el === document.activeElement), true);
      assert.equal(await cards.first().evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
      await page.keyboard.press('Enter');
      for (let i = 1; i < 6; i++) await cards.nth(i).click();
      assert.deepEqual(await page.evaluate(() => window.launcherCalls), [['open', 'sidechat'], ['open', 'route'], ['create', 'browser'], ['create', 'terminal'], ['open', 'workspace'], ['open', 'git']]);
    }
    await page.goto(url + '?lang=en'); await cards.first().waitFor();
    assert.deepEqual(await cards.allTextContents().then(texts => texts.map(t => t.trim())), ['Side chat', 'Changes', 'Browser', 'Terminal', 'File', 'Git']);
    await page.setViewportSize({ width: 240, height: 350 });
    const layout = await cards.evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }));
    assert(layout.every(rect => rect.x >= 0 && rect.y >= 0 && rect.right <= 240 && rect.bottom <= 350));
    assert.equal(layout[0].y, layout[1].y); assert.equal(layout[2].y, layout[3].y);
    const beforeCustom = await cards.first().evaluate(el => getComputedStyle(el).backgroundColor);
    await page.evaluate(() => { document.documentElement.style.setProperty('--bg-app', '#0a1410'); document.documentElement.style.setProperty('--text-1', '#e6f2e8'); });
    const custom = await cards.first().evaluate(el => getComputedStyle(el).backgroundColor);
    assert.notEqual(custom, beforeCustom, 'launcher follows custom theme tokens rather than fixed gray');
    await page.screenshot({ path: '.tmp/qa/workbench-launcher-custom-narrow.png' });
    await page.goto(url + '?no-workspace=1'); await cards.first().waitFor();
    await page.getByRole('button', { name: '文件', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.launcherCalls), [['choose-workspace']]);
    assert.deepEqual(errors, []);
    console.log('PASS workbench launcher: flat/borderless/compact six-entry grid, neutral hover/focus, unchanged actions, Chinese/English, light/dark/custom/narrow, workspace guard; no browser errors.');
  }
} finally { await browser.close(); await server.close(); }

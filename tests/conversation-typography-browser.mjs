import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const baseline = process.argv.includes('--baseline');
const built = process.argv.includes('--built-css');
const compareBaseline = process.argv.includes('--compare-baseline');
const server = await createServer({ configFile: false, cacheDir: '.tmp/conversation-typography-vite',
  optimizeDeps: { entries: ['tests/fixtures/conversation-typography.html'] },
  server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.fixtureCopiedCode = text; } } });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/conversation-typography.html`);
  const body = page.locator('.assistant-message-content > .markdown-message');
  await body.locator('h6').waitFor();
  if (built) {
    const index = await readFile('dist/index.html', 'utf8');
    const stylesheet = index.match(/href="\.\/(assets\/[^" ]+\.css)"/);
    assert(stylesheet, 'built index references the production stylesheet');
    const css = await readFile(`dist/${stylesheet[1]}`, 'utf8');
    await page.evaluate(() => document.querySelectorAll('style,link[rel="stylesheet"]').forEach(element => element.remove()));
    await page.addStyleTag({ content: css });
  }
  const contents = await body.textContent();
  const style = async locator => locator.evaluate(element => {
    const s = getComputedStyle(element);
    return Object.fromEntries(['fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'letterSpacing', 'marginTop', 'marginBottom', 'paddingLeft', 'paddingRight', 'borderTopWidth', 'borderBottomWidth', 'borderRadius', 'color', 'backgroundColor', 'boxShadow', 'display', 'listStylePosition'].map(key => [key, s[key]]));
  });
  const unaffected = async () => ({
    progress: await style(page.locator('.assistant-progress-entry .markdown-message')),
    progressCode: await style(page.locator('.assistant-progress-entry code')),
    heading: await style(page.locator('.assistant-message-heading strong')),
    user: await style(page.locator('.user-message .message-bubble').first()),
    code: await style(body.locator('.code-block code')),
    codeSurface: await style(body.locator('.code-block')),
    table: await style(body.locator('table')),
  });
  await mkdir('.tmp/qa/conversation-typography', { recursive: true });
  const snapshots = {};
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [960, 600, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const key = `${theme}-${width}`;
      const metrics = { body: await style(body), paragraph: await style(body.locator(':scope > p').first()),
        headings: await Promise.all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(tag => style(body.locator(tag)))),
        list: await style(body.locator('ul').first()), item: await style(body.locator(':scope > ul > li').nth(1)),
        inline: await style(body.locator(':scope > p code').first()) };
      snapshots[key] = await unaffected();
      if (!baseline) {
        assert.equal(metrics.body.fontSize, '14px', key);
        assert.equal(metrics.body.fontWeight, '500', 'reply text is slightly heavier');
        assert.equal(metrics.paragraph.fontWeight, '500', 'paragraphs inherit the slightly heavier weight');
        assert.equal(metrics.item.fontWeight, '500', 'list items inherit the slightly heavier weight');
        assert.equal(metrics.body.lineHeight, '24.5px', key);
        assert(Math.abs(parseFloat(metrics.body.letterSpacing) + 0.14) < 0.001, 'body tracking is subtly tighter');
        assert.equal(metrics.paragraph.marginBottom, '10px', key);
        for (const [i, heading] of metrics.headings.entries()) {
          assert.equal(heading.fontSize, '14px', `${key}/h${i + 1}`);
          assert(Math.abs(parseFloat(heading.letterSpacing) + 0.14) < 0.001, 'heading tracking matches the body');
          assert.equal(heading.fontWeight, '600');
          assert.equal(heading.borderTopWidth, '0px');
          assert.equal(heading.backgroundColor, 'rgba(0, 0, 0, 0)');
          assert.equal(heading.paddingLeft, '0px');
          assert.equal(heading.marginTop, '14px'); assert.equal(heading.marginBottom, '6px');
        }
        assert.equal(metrics.list.paddingLeft, '22px');
        assert.equal(metrics.list.listStylePosition, 'outside');
        assert.equal(metrics.item.marginTop, '3px');
        assert.equal(metrics.item.marginBottom, '0px');
        if (theme === 'dark') {
          const expected = await body.evaluate(element => {
            const probe = document.createElement('span');
            probe.style.color = 'color-mix(in srgb, var(--text-1) 70%, var(--text-2))';
            element.append(probe); const color = getComputedStyle(probe).color; probe.remove();
            return color;
          });
          assert.equal(metrics.paragraph.color, expected, 'dark reply text uses a softer theme-aware gray');
          assert.equal(metrics.item.color, expected, 'list text and markers use the same softer color');
          assert.equal(metrics.inline.color, expected, 'inline code does not remain glaring white');
          assert.notEqual(metrics.paragraph.color, metrics.body.color, 'the change does not dim headings or the entire UI');
        } else {
          const expected = await body.evaluate(element => {
            const probe = document.createElement('span');
            probe.style.color = 'color-mix(in srgb, var(--text-1) 85%, #000)';
            element.append(probe); const color = getComputedStyle(probe).color; probe.remove();
            return color;
          });
          assert.equal(metrics.paragraph.color, expected, 'light reply text is subtly darker');
          assert.equal(metrics.item.color, expected, 'light lists use the darker reading color');
          assert.equal(metrics.inline.color, expected, 'light inline code matches the reading text');
          assert.notEqual(metrics.paragraph.color, metrics.body.color, 'headings and other UI keep their original colors');
        }
        assert.equal(metrics.inline.borderTopWidth, '0px');
        assert(Math.abs(parseFloat(metrics.inline.fontSize) - 12.6) < 0.01, 'inline code scales with body text');
        assert.equal(metrics.inline.letterSpacing, 'normal', 'inline code keeps its monospaced tracking');
        assert.equal(metrics.inline.paddingLeft, '3px');
        assert.equal(metrics.inline.paddingRight, '3px');
        assert(Math.abs(parseFloat(snapshots[key].code.fontSize) - 13.585) < 0.01, 'fenced code is 95% of its previous size');
        const toolbar = await style(body.locator('.code-block-toolbar'));
        const preformatted = body.locator('.code-block pre');
        assert.equal(snapshots[key].codeSurface.borderTopWidth, '0px', 'fenced code has no outline');
        assert.equal(snapshots[key].codeSurface.backgroundColor, snapshots[key].table.backgroundColor, 'code uses the same surface as tables');
        assert.equal(snapshots[key].codeSurface.borderRadius, snapshots[key].table.borderRadius, 'code and tables use the same corner radius');
        assert.equal(toolbar.backgroundColor, 'rgba(0, 0, 0, 0)', 'the header shares the code surface');
        assert.equal(toolbar.borderBottomWidth, '0px', 'there is no prominent header separator');
        assert.equal(toolbar.paddingLeft, (await style(preformatted)).paddingLeft, 'language label and code align');
        if (width === 320) {
          assert(await preformatted.evaluate(element => {
            element.scrollLeft = element.scrollWidth;
            const scrollable = element.scrollLeft > 0;
            element.scrollLeft = 0;
            return scrollable;
          }), 'long PowerShell lines scroll horizontally inside the code block');
        }
        assert.equal(snapshots[key].progress.fontSize, '14px', 'progress uses the reply typography');
        assert.equal(snapshots[key].progress.fontWeight, '500', 'progress uses the reply weight');
        assert.equal(snapshots[key].progress.lineHeight, '24.5px');
        assert.equal(snapshots[key].user.fontSize, '14px', 'user message size matches the original bubble style');
        assert.equal(snapshots[key].user.fontWeight, '500', 'user message text is slightly heavier');
        assert.equal(snapshots[key].user.lineHeight, '22.4px', 'user message line spacing matches the original bubble style');
        for (const bubble of await page.locator('.user-message .message-bubble').all()) {
          const appearance = await style(bubble);
          assert.equal(appearance.borderRadius, '22px', 'all four bubble corners have the same radius');
          assert.equal(appearance.borderTopWidth, '0px', 'no outline around the user bubble');
          assert.equal(appearance.borderBottomWidth, '0px', 'no outline at the bottom either');
          assert.equal(appearance.boxShadow, 'none', 'no simulated outline');
          assert(await bubble.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'the user bubble wraps content without horizontal overflow');
        }
        assert.equal(snapshots[key].table.lineHeight, '18.2px', 'table line spacing is compact');
        assert.equal(snapshots[key].code.lineHeight, '19.5px', 'code line spacing is compact');
        assert.equal(snapshots[key].progressCode.borderTopWidth, '0px', 'progress inline code uses the same quiet style');
        assert.equal(snapshots[key].progressCode.paddingLeft, '3px');
        assert.equal(await page.locator('.assistant-progress-entry h3').evaluate(el => getComputedStyle(el).fontSize), '14px');
        assert.equal(await page.locator('.assistant-progress-entry h3').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
        assert.equal(snapshots[key].heading.fontSize, '14px', 'message header remains unchanged');
        const alignment = await body.locator(':scope > ul > li').first().evaluate(element => {
          const text = [...element.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
          const range = document.createRange(); range.selectNodeContents(text);
          return { left: element.getBoundingClientRect().left, lines: [...range.getClientRects()].map(rect => ({ x: rect.x, width: rect.width })) };
        });
        assert(alignment.lines.length > 1, 'fixture wraps the long list entry');
        for (const line of alignment.lines.slice(1)) assert(Math.abs(line.x - alignment.left) < 1, 'wrapped lines align with the text, not the marker');
        assert.equal(await body.textContent(), contents, 'styles do not alter the model output');
        const table = body.locator('.conversation-table-scroll');
        assert.equal(await table.getAttribute('tabindex'), '0', 'scrolling table is keyboard focusable');
        for (const header of await table.locator('th').all()) {
          assert.equal(await header.evaluate(element => {
            const range = document.createRange(); range.selectNodeContents(element);
            return range.getClientRects().length;
          }), 1, 'column headers stay on one line');
        }
        if (width === 320) {
          assert(await table.evaluate(element => element.scrollWidth > element.clientWidth), 'narrow table scrolls within its container');
          await table.focus();
          await page.keyboard.press('ArrowRight');
          await page.waitForTimeout(150);
          assert(await table.evaluate(element => element.scrollLeft > 0), 'keyboard can scroll the table');
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no viewport overflow');
      }
      await page.locator('.assistant-message').screenshot({ path: `.tmp/qa/conversation-typography/${baseline ? 'before' : built ? 'built' : 'after'}-${key}.png` });
      if (built && width === 960) await page.locator('.user-message .message-bubble').first().screenshot({ path: `.tmp/qa/conversation-typography/bubble-${theme}.png` });
      console.log(`${baseline ? 'BASELINE' : 'PASS'} ${key}: body=${metrics.body.fontSize}/${metrics.body.lineHeight}, heading=${metrics.headings[0].fontSize}, inlineBorder=${metrics.inline.borderTopWidth}`);
    }
  }
  if (!baseline) {
    const codeBlock = body.locator('.code-block');
    assert.equal(await codeBlock.locator('.code-block-toolbar > span').innerText(), 'powershell');
    const copy = codeBlock.getByRole('button', { name: '复制', exact: true });
    await copy.focus();
    await page.keyboard.press('Enter');
    await codeBlock.getByRole('button', { name: '已复制', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureCopiedCode), await codeBlock.locator('code').textContent(), 'copy preserves the exact command');
  }
  // Compare untouched surfaces against the pre-change browser measurements.
  if (baseline) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile('.tmp/qa/conversation-typography/unchanged-surfaces.json', JSON.stringify(snapshots));
  } else if (compareBaseline) {
    const before = JSON.parse(await readFile('.tmp/qa/conversation-typography/unchanged-surfaces.json', 'utf8'));
    const untouched = values => Object.fromEntries(Object.entries(values).map(([key, { heading }]) => [key, { heading }]));
    assert.deepEqual(untouched(snapshots), untouched(before), 'message headers remain unchanged');
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}

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
    return Object.fromEntries(['fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'letterSpacing', 'marginTop', 'marginBottom', 'paddingLeft', 'paddingRight', 'borderTopWidth', 'color', 'backgroundColor', 'boxShadow', 'display', 'listStylePosition'].map(key => [key, s[key]]));
  });
  const unaffected = async () => ({
    progress: await style(page.locator('.assistant-progress-entry .markdown-message')),
    progressCode: await style(page.locator('.assistant-progress-entry code')),
    heading: await style(page.locator('.assistant-message-heading strong')),
    user: await style(page.locator('.user-message')),
    code: await style(body.locator('.code-block code')),
    codeSurface: await style(body.locator('.code-block')),
    table: await style(body.locator('table')),
  });
  await mkdir('.tmp/qa/conversation-typography', { recursive: true });
  const snapshots = {};
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [960, 600]) {
      await page.setViewportSize({ width, height: 1000 });
      const key = `${theme}-${width}`;
      const metrics = { body: await style(body), paragraph: await style(body.locator(':scope > p').first()),
        headings: await Promise.all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(tag => style(body.locator(tag)))),
        list: await style(body.locator('ul').first()), item: await style(body.locator(':scope > ul > li').nth(1)),
        inline: await style(body.locator(':scope > p code').first()) };
      snapshots[key] = await unaffected();
      if (!baseline) {
        assert.equal(metrics.body.fontSize, '14px', key);
        assert.equal(metrics.body.lineHeight, '24.5px', key);
        assert(Math.abs(parseFloat(metrics.body.letterSpacing) + 0.14) < 0.001, 'body tracking is subtly tighter');
        assert.equal(metrics.paragraph.marginBottom, '10px', key);
        for (const [i, heading] of metrics.headings.entries()) {
          assert.equal(heading.fontSize, i < 2 ? '17px' : '14px', `${key}/h${i + 1}`);
          assert(Math.abs(parseFloat(heading.letterSpacing) + (i < 2 ? 0.17 : 0.14)) < 0.001, 'heading tracking matches the compact body');
          assert.equal(heading.fontWeight, '600');
          assert.equal(heading.borderTopWidth, '0px');
          assert.equal(heading.backgroundColor, 'rgba(0, 0, 0, 0)');
          assert.equal(heading.paddingLeft, '0px');
          if (i < 2) { assert.equal(heading.marginTop, '22px'); assert.equal(heading.marginBottom, '10px'); }
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
          assert.equal(metrics.paragraph.color, metrics.body.color, 'light reply text stays unchanged');
        }
        assert.equal(metrics.inline.borderTopWidth, '0px');
        assert.equal(metrics.inline.fontSize, '12.6px');
        assert.equal(metrics.inline.letterSpacing, 'normal', 'inline code keeps its monospaced tracking');
        assert.equal(metrics.inline.paddingLeft, '3px');
        assert.equal(metrics.inline.paddingRight, '3px');
        assert.equal(snapshots[key].code.fontSize, '13px', 'fenced code size is unchanged');
        assert.equal(snapshots[key].codeSurface.borderTopWidth, '1px', 'fenced code surface is unchanged');
        assert.equal(snapshots[key].progress.fontSize, '14px', 'progress uses the compact reply typography');
        assert.equal(snapshots[key].progress.lineHeight, '24.5px');
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
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no viewport overflow');
      }
      await page.locator('.assistant-message').screenshot({ path: `.tmp/qa/conversation-typography/${baseline ? 'before' : built ? 'built' : 'after'}-${key}.png` });
      console.log(`${baseline ? 'BASELINE' : 'PASS'} ${key}: body=${metrics.body.fontSize}/${metrics.body.lineHeight}, heading=${metrics.headings[0].fontSize}, inlineBorder=${metrics.inline.borderTopWidth}`);
    }
  }
  // Compare untouched surfaces against the pre-change browser measurements.
  if (baseline) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile('.tmp/qa/conversation-typography/unchanged-surfaces.json', JSON.stringify(snapshots));
  } else if (compareBaseline) {
    const before = JSON.parse(await readFile('.tmp/qa/conversation-typography/unchanged-surfaces.json', 'utf8'));
    const untouched = values => Object.fromEntries(Object.entries(values).map(([key, { progress, progressCode, ...rest }]) => [key, rest]));
    assert.deepEqual(untouched(snapshots), untouched(before), 'user bubbles, headers, tables and fenced code are unchanged; progress intentionally uses the new typography');
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}

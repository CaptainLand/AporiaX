import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const built = process.argv.includes('--built-css');
const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 560, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/markdown-reader.html');
  const reader = page.getByRole('article', { name: 'Markdown 阅读视图' });
  await reader.locator('h6').waitFor();
  if (built) {
    const index = await readFile('dist/index.html', 'utf8');
    const stylesheet = index.match(/href="\.\/(assets\/[^" ]+\.css)"/);
    assert(stylesheet);
    await page.evaluate(() => document.querySelectorAll('style,link[rel="stylesheet"]').forEach(element => {
      if (!element.textContent?.includes('.reader-fixture')) element.remove();
    }));
    await page.addStyleTag({ content: await readFile(`dist/${stylesheet[1]}`, 'utf8') });
  }
  await mkdir('.tmp/qa/markdown-reader', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [560, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      const metrics = await reader.evaluate(element => {
        const css = node => getComputedStyle(node);
        const root = css(document.documentElement);
        const probe = document.createElement('span');
        probe.style.color = 'color-mix(in srgb, var(--text-1) 70%, var(--text-2))';
        element.append(probe);
        const expectedDarkText = css(probe).color; probe.remove();
        const cell = css(element.querySelector('td'));
        const code = css(element.querySelector('p code'));
        const quote = css(element.querySelector('blockquote'));
        const hr = css(element.querySelector('hr'));
        return {
          size: css(element).fontSize, line: css(element).lineHeight,
          font: css(element).fontFamily, expectedFont: root.getPropertyValue('--font-sans').trim(),
          color: css(element).color, expectedDarkText,
          headings: [...element.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(node => ({
            size: css(node).fontSize, weight: css(node).fontWeight, border: css(node).borderBottomWidth,
            background: css(node).backgroundColor,
          })),
          paragraphGap: css(element.querySelector(':scope > p')).marginBottom,
          itemGap: css(element.querySelector('ul > li + li')).marginTop,
          codeBorder: code.borderTopWidth, codeSize: code.fontSize,
          preSize: css(element.querySelector('pre code')).fontSize,
          cells: { left: cell.borderLeftWidth, right: cell.borderRightWidth, top: cell.borderTopWidth, bottom: cell.borderBottomWidth },
          quoteBorder: quote.borderLeftWidth, quoteColor: quote.borderLeftColor,
          hrBorder: hr.borderTopWidth, hrHeight: hr.height, hrBackground: hr.backgroundColor,
          overflow: element.scrollWidth > element.clientWidth,
          wideTableScrollable: element.querySelectorAll('.document-table-scroll')[1].scrollWidth > element.querySelectorAll('.document-table-scroll')[1].clientWidth,
          tableFills: Math.abs(element.querySelector('table').getBoundingClientRect().width - element.querySelector('.document-table-scroll').getBoundingClientRect().width) < 1,
          codeScrollable: element.querySelectorAll('pre')[1].scrollWidth > element.querySelectorAll('pre')[1].clientWidth,
        };
      });
      assert.equal(metrics.size, '14px');
      assert.ok(metrics.font.startsWith('Inter'), 'reader uses the app typeface');
      assert.equal(metrics.line, '24.5px');
      assert.equal(metrics.paragraphGap, '10px');
      assert.equal(metrics.itemGap, '3px');
      for (const heading of metrics.headings) {
        assert.equal(heading.weight, '600');
        assert.equal(heading.border, '0px');
        assert.equal(heading.background, 'rgba(0, 0, 0, 0)');
      }
      assert.deepEqual(metrics.headings.slice(0, 2).map(heading => heading.size), ['18px', '16px']);
      assert.ok(metrics.headings.slice(2).every(heading => heading.size === '14px' || heading.size === '16px'));
      assert.equal(metrics.cells.left, '0px'); assert.equal(metrics.cells.right, '0px');
      assert.equal(metrics.cells.top, '0px'); assert.equal(metrics.cells.bottom, '1px');
      assert.equal(metrics.codeBorder, '0px'); assert.equal(metrics.codeSize, '12.6px');
      assert.equal(metrics.preSize, '13px'); assert.equal(metrics.quoteBorder, '2px');
      assert.equal(metrics.hrBorder, '0px'); assert.equal(metrics.hrHeight, '1px');
      assert.notEqual(metrics.hrBackground, 'rgb(255, 255, 255)');
      if (theme === 'dark') assert.equal(metrics.color, metrics.expectedDarkText);
      assert.equal(metrics.overflow, false, 'wide content must not overflow the document');
      assert.equal(metrics.tableFills, true, 'normal tables fill the reading column');
      assert.equal(metrics.wideTableScrollable, true, 'wide table retains internal scrolling');
      assert.equal(metrics.codeScrollable, true);
      await reader.evaluate(element => element.scrollTop = 0);
      await reader.screenshot({ path: `.tmp/qa/markdown-reader/${built ? 'built-' : ''}${theme}-${width}.png` });
    }
  }
  await reader.getByRole('link', { name: '使用说明', exact: true }).click();
  assert.ok(await reader.evaluate(element => element.scrollTop > 0), 'heading anchor still scrolls the document');
  await reader.getByRole('link', { name: '另一份文档', exact: true }).click();
  assert.equal(await page.evaluate(() => window.readerOpenedHref), 'docs/other.md');
  assert.equal(await reader.locator('input[type="checkbox"]').count(), 2);
  assert.ok(await reader.locator('.hljs-keyword').count());
  assert.equal(await page.evaluate(() => Boolean(window.MARKDOWN_SCRIPT_RAN)), false);
  assert.equal(await page.evaluate(() => window.readerError), undefined);
  assert.deepEqual(errors, []);
  console.log(`PASS ${built ? 'built' : 'dev'} Markdown reader: compact typography, quiet rules/tables/quotes, dark text, narrow overflow, anchors/links/tasks/highlighting and safe rendering.`);
} finally { await browser?.close(); await server.close(); }

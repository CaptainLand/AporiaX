import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { themeTokens } from '../shared/appearance.js';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1150, height: 850 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await mkdir('.tmp/qa', { recursive: true });
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/workspace-knowledge-refined.html');
  const tree = page.locator('.workspace-tree');
  await tree.getByRole('button', { name: 'src', exact: true }).click();
  await tree.getByRole('button', { name: 'App.jsx', exact: true }).waitFor();
  assert.equal(await tree.getByRole('button', { name: 'src', exact: true }).getAttribute('aria-expanded'), 'true');
  const search = page.getByRole('textbox', { name: '搜索已加载的工作区文件' });
  await search.fill('app.jsx');
  assert.equal(await tree.getByRole('button').count(), 1);
  await search.fill('');
  await tree.getByRole('button', { name: 'README.md', exact: true }).click();
  await page.locator('.workspace-rich-preview').waitFor();
  await page.getByRole('heading', { name: '星河工作台', exact: true }).waitFor();
  await page.getByRole('button', { name: '在侧栏打开或编辑', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.refinedFixture.opened), ['README.md']);
  for (const theme of ['light', 'dark', 'custom']) {
    await page.evaluate(({ theme, tokens }) => {
      const root = document.documentElement; root.dataset.theme = theme === 'light' ? 'light' : 'dark';
      if (theme === 'custom') { root.dataset.customTheme = 'refined'; for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value); }
      else { delete root.dataset.customTheme; root.removeAttribute('style'); }
    }, { theme, tokens: themeTokens({ base: 'dark', colors: { accent: '#31c48d', background: '#0a1410', panel: '#12201a', text: '#e6f2e8' } }) });
    await page.evaluate(() => { window.refinedFixture.side(false); window.refinedFixture.view('workspace'); });
    await page.locator('.file-explorer-panel').waitFor();
    await tree.getByRole('button', { name: 'README.md', exact: true }).click();
    await page.getByRole('heading', { name: '星河工作台', exact: true }).waitFor();
    assert.equal(await page.locator('.file-search input').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'search has one continuous soft background');
    assert.equal(await tree.locator('button.active').evaluate(el => getComputedStyle(el).boxShadow), 'none', 'selected file has no legacy accent stripe');
    assert.notEqual(await tree.evaluate(el => getComputedStyle(el).backgroundColor), await page.locator('.file-explorer-panel').evaluate(el => getComputedStyle(el).backgroundColor), 'file list is separated by soft tone instead of a border');
    assert.equal(await tree.evaluate(el => getComputedStyle(el).backgroundColor), await page.locator('.workspace-preview').evaluate(el => getComputedStyle(el).backgroundColor));
    for (const selector of ['.file-explorer-panel', '.file-explorer-panel > header', '.file-explorer-body', '.workspace-tree', '.workspace-inline-toolbar']) {
      assert.deepEqual(await page.locator(selector).evaluate(el => { const s = getComputedStyle(el); return [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth]; }), Array(4).fill('0px'), `${theme}: ${selector} has no divider lines`);
    }
    await page.screenshot({ path: `.tmp/qa/workspace-refined-${theme}.png` });
    await page.evaluate(() => window.refinedFixture.view('understanding'));
    await page.locator('.knowledge-item').first().waitFor();
    assert.equal(await page.locator('.knowledge-item').count(), 8);
    for (const selector of ['.knowledge-list', '.knowledge-item', '.knowledge-search']) {
      assert.equal(await page.locator(selector).first().evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
    }
    await page.screenshot({ path: `.tmp/qa/knowledge-refined-${theme}.png` });
    await page.locator('.knowledge-detail-trigger').first().click();
    await page.getByRole('complementary', { name: '知识详情', exact: true }).waitFor();
    await page.locator('.knowledge-inspector').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    assert.equal(await page.locator('.knowledge-inspector').evaluate(el => getComputedStyle(el).opacity), '1');
    await page.screenshot({ path: `.tmp/qa/knowledge-refined-detail-${theme}.png` });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 420, height: 850 });
  await page.evaluate(() => window.refinedFixture.side(true));
  await page.locator('.knowledge-item').first().waitFor();
  assert.equal(await page.locator('.knowledge-panel').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.locator('.knowledge-detail-trigger').first().click();
  assert.equal(await page.locator('.knowledge-main').isVisible(), false, 'narrow inspector replaces list');
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await page.screenshot({ path: '.tmp/qa/knowledge-refined-sidebar.png' });
  await page.evaluate(() => window.refinedFixture.task({ knowledgeEnabled: false }));
  await page.getByText('此对话尚未开启项目知识', { exact: true }).waitFor();
  assert.equal(await page.locator('.knowledge-item').count(), 0);
  const reads = await page.evaluate(() => window.refinedFixture.reads.length);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('aporiax:knowledge-changed', { detail: 'D:/Demo/Starlight' })));
  assert.equal(await page.evaluate(() => window.refinedFixture.reads.length), reads, 'disabled knowledge makes no reads');
  await page.getByRole('button', { name: '为此对话开启项目知识', exact: true }).click();
  await page.locator('.knowledge-item').first().waitFor();
  await page.evaluate(() => window.refinedFixture.view('workspace'));
  await page.getByRole('textbox', { name: '工作区文件搜索', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.file-explorer-panel > header').isVisible(), false, 'sidebar files do not show full-page heading or path');
  assert.equal(await page.locator('.workspace-preview').isVisible(), false, 'sidebar files have no embedded preview');
  assert.equal(await page.locator('.file-explorer-panel .workspace-tree').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'sidebar is a plain filename index rather than a large card');
  await tree.getByRole('button', { name: 'README.md', exact: true }).dblclick();
  await page.getByRole('textbox', { name: '工作区文件搜索', exact: true }).fill('README');
  await page.locator('.workbench-search-hint').waitFor();
  await page.screenshot({ path: '.tmp/qa/workspace-refined-search-sidebar.png' });
  await page.evaluate(() => { window.refinedFixture.searchEntries = [{ path: 'docs/guide.md', type: 'file' }]; });
  await page.getByRole('textbox', { name: '工作区文件搜索', exact: true }).fill('guide');
  const nestedFile = page.getByRole('button', { name: 'guide.md', exact: true });
  await nestedFile.waitFor();
  assert.match(await nestedFile.getAttribute('title'), /docs\/guide\.md/);
  await nestedFile.dblclick();
  assert.equal(await page.evaluate(() => window.refinedFixture.opened.at(-1)), 'docs/guide.md', 'basename-only search still opens the full file path');
  await page.getByRole('textbox', { name: '工作区文件搜索', exact: true }).fill('');
  await page.screenshot({ path: '.tmp/qa/workspace-refined-sidebar.png' });
  assert.equal(await page.locator('.file-explorer-panel').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.evaluate(() => { window.refinedFixture.side(false); window.refinedFixture.task({ workspacePath: 'D:/Demo/这是一个用于验证窄面板的很长工作区路径/Starlight' }); });
  await tree.getByRole('button', { name: 'README.md', exact: true }).waitFor();
  assert.equal(await page.locator('.file-explorer-panel').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'main browser fits a narrow panel with a long workspace path');
  await tree.getByRole('button', { name: 'README.md', exact: true }).click();
  await page.getByRole('heading', { name: '星河工作台', exact: true }).waitFor();
  assert.equal(await page.locator('.file-explorer-body').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'tree and preview do not overflow the compact main pane');
  await page.screenshot({ path: '.tmp/qa/workspace-refined-compact-main.png' });
  assert.deepEqual(await page.evaluate(() => window.refinedFixture.writes), [], 'redesign does not change recording settings');
  assert.deepEqual(errors, []);
  console.log('PASS workspace/knowledge redesign: line-free themes, directory expansion, search, read-only preview/sidebar edit entry, knowledge disclosure, narrow sidebar, default-off gate and no writes.');
} finally { await browser.close(); await server.close(); }

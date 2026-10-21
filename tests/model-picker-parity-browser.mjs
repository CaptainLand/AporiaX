import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer, preview } from 'vite';
import { chromium } from 'playwright-core';
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
    localStorage.clear(); localStorage.setItem('aporiax.language.v1', 'zh-CN'); localStorage.setItem('aporiax.theme.v2', 'light');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'picker', welcomeDismissed: true }));
    const models = [
      { id: 'cloud-fixture', kind: 'aporia-cloud', accountStatus: 'anonymous', cloudCatalogVerified: true, name: 'Cloud', models: [{ id: 'cloud', name: 'Cloud unavailable', shortName: 'Cloud', disabled: true, disabledReasonZh: '请先登录' }] },
      { id: 'own', name: 'Own API', models: [{ id: 'alpha', name: 'Alpha', shortName: 'Alpha', supportsThinking: true }, { id: 'beta', name: 'Beta', shortName: 'Beta' }] },
      { id: 'local', source: 'local', name: 'Local API', models: [{ id: 'local', name: 'Local model', shortName: 'Local' }] },
    ];
    const task = { id: 'picker', title: '模型选择复用测试', workspaceName: 'Fixture', workspacePath: 'D:/Fixture', providerId: 'own', modelId: 'alpha', thinking: false, builderLimit: 2, messages: [{ id: 'answer', role: 'assistant', status: 'completed', content: '合成测试，不调用模型。' }] };
    const extraCount = new URLSearchParams(location.search).get('modelCount') === '7' ? 3 : 4;
    models[1].models.push(...Array.from({ length: extraCount }, (_, i) => ({ id: `extra-${i}`, name: `Extra ${i}` })));
    window.pickerCalls = [];
    window.desktop = {
      theme: { set: async () => {} }, providers: { list: async () => models }, account: { get: async () => ({ status: 'anonymous' }) },
      tasks: { load: async () => [task], save: async tasks => { window.pickerSavedTasks = tasks; } },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] }, sandbox: { status: async () => ({ localAvailable: true }) },
      workspace: { listTree: async () => ({ entries: [] }) },
      workbench: { subscribe: () => () => {}, request: async input => { window.pickerCalls.push(input); return input.action === 'list' ? [] : true; } },
      sideChat: { subscribe: () => () => {}, request: async input => { window.pickerCalls.push(input); return {
        id: 'picker-temporary', taskId: task.id, scope: input.scope, revision: 1,
        settings: { providerId: 'own', modelId: 'alpha', thinking: true, effort: 'high' }, messages: [],
      }; } },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.assistant-message').waitFor();
  await page.getByRole('button', { name: '打开工作侧栏', exact: true }).click();
  await page.getByRole('button', { name: '打开内容', exact: true }).click();
  await page.getByRole('menuitem', { name: '临时聊天', exact: true }).click();
  const mainTrigger = page.locator('.thread .composer .model-trigger'), sideTrigger = page.locator('.temporary-chat .model-trigger');
  await sideTrigger.waitFor();
  const mainMenu = page.getByRole('dialog', { name: '选择模型', exact: true });
  const sideMenu = page.getByRole('dialog', { name: '选择模型', exact: true });
  const snapshot = menu => menu.evaluate(el => {
    const style = node => { const c = getComputedStyle(node); return { width: c.width, padding: c.padding, fontSize: c.fontSize, fontWeight: c.fontWeight,
      border: c.border, radius: c.borderRadius, background: c.backgroundColor, color: c.color, opacity: c.opacity }; };
    return { surface: style(el), groups: [...el.querySelectorAll('.model-menu-source-group > .model-menu-heading')].map(n => n.textContent),
      notes: [...el.querySelectorAll('.model-menu-source-note')].map(n => n.textContent),
      rows: [...el.querySelectorAll('.model-choice')].map(n => ({ text: n.textContent, disabled: n.disabled, selected: n.classList.contains('selected'), style: style(n) })),
      setup: [...el.querySelectorAll('.model-setup-actions button')].map(n => ({ text: n.textContent, disabled: n.disabled, opacity: getComputedStyle(n).opacity })) };
  });
  await mkdir('.tmp/qa', { recursive: true });
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.theme-toggle').click();
    await mainTrigger.click(); await mainMenu.waitFor(); const main = await snapshot(mainMenu);
    assert.equal(await mainMenu.getByRole('switch', { name: '深度思考', exact: true }).count(), 0);
    assert.equal(await mainMenu.locator('.model-menu-effort').count(), 0, 'model and effort menus are separate');
    assert.equal(await mainMenu.evaluate(el => getComputedStyle(el).boxShadow), 'none');
    await mainMenu.screenshot({ path: `.tmp/qa/model-picker-main-${theme}.png` });
    await mainMenu.getByRole('textbox', { name: '搜索模型' }).press('Escape');
    assert.equal(await mainTrigger.evaluate(el => el === document.activeElement), true);
    const effortTrigger = page.locator('.thread').getByRole('button', { name: '切换思考强度', exact: true });
    assert.equal(await effortTrigger.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await mainTrigger.locator('.lucide-brain').count(), 0);
    assert.equal(await mainTrigger.locator('svg').count(), 0, 'model dropdown chevron removed');
    const toolbarCenters = await page.evaluate(() => ['.composer-add[data-composer-add] svg', '.composer .model-trigger > span', '.composer .effort-trigger'].map(selector => {
      const el = document.querySelector(selector), bounds = el.getBoundingClientRect();
      return bounds.y + bounds.height / 2;
    }));
    assert(Math.max(...toolbarCenters) - Math.min(...toolbarCenters) < 1, 'plus, model and effort share one center line');
    const textOffset = await page.evaluate(() => {
      const model = document.querySelector('.composer .model-trigger > span').getBoundingClientRect();
      const effort = document.querySelector('.composer .effort-trigger > span').getBoundingClientRect();
      return effort.y + effort.height / 2 - model.y - model.height / 2;
    });
    assert(Math.abs(textOffset - 1) < .25, 'smaller uppercase effort text is optically lowered by 1px, not just button-box aligned');
    await effortTrigger.click();
    const effortMenu = page.getByRole('dialog', { name: '思考强度', exact: true });
    const slider = effortMenu.getByRole('slider', { name: '思考强度', exact: true });
    assert.equal(await slider.getAttribute('max'), '1');
    assert.equal(await slider.evaluate(el => getComputedStyle(el).cursor), 'default');
    await page.waitForFunction(() => ['animated', 'fallback'].includes(document.querySelector('.effort-gem')?.dataset.state));
    assert.equal(await effortMenu.locator('.effort-gem').getAttribute('data-state'), 'animated', 'website Gem effect renders, not just its CSS fallback');
    assert.doesNotMatch(await effortMenu.innerText(), /Alpha/);
    assert.equal(await effortMenu.locator('svg, button').count(), 0);
    await slider.press('End');
    assert.equal(await slider.getAttribute('aria-valuetext'), 'Max');
    await effortMenu.screenshot({ path: `.tmp/qa/model-effort-${theme}.png`, animations: 'disabled' });
    await slider.press('Home');
    assert.equal(await slider.getAttribute('aria-valuetext'), 'High');
    await effortMenu.press('Escape');
    assert.equal(await page.locator('.effort-gem canvas').count(), 0, 'closing the picker removes its animation canvas');
    assert.equal(await effortTrigger.evaluate(el => el === document.activeElement), true);
    await sideTrigger.click(); await sideMenu.waitFor(); const side = await snapshot(sideMenu);
    assert.deepEqual(side, main, `${theme}: shared model list, source notes, selected/disabled styles and setup match`);
    assert.equal(await sideMenu.getByRole('switch', { name: '深度思考', exact: true }).count(), 0, 'No unimplemented side-chat reasoning controls');
    assert.equal(await sideMenu.locator('[data-source="user-provider"] .model-choice small').count(), 0, 'own-model subtitles removed');
    assert.ok(await sideMenu.locator('[data-source="aporia-cloud"] .model-choice small').count(), 'Cloud availability/billing note retained');
    await sideMenu.screenshot({ path: `.tmp/qa/model-picker-side-${theme}.png` });
    await sideMenu.getByRole('textbox', { name: '搜索模型' }).press('Escape');
  }
  await sideTrigger.click(); await sideMenu.waitFor();
  const search = sideMenu.getByRole('textbox', { name: '搜索模型' });
  await search.fill('Cloud unavailable'); await search.press('Enter'); assert.equal(await sideMenu.isVisible(), true);
  await search.fill('Beta');
  await search.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  assert.equal(await sideMenu.isVisible(), true, 'IME composition cannot select a model');
  await search.press('ArrowDown'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.temporary-chat .model-trigger')?.textContent.includes('Beta'));
  await page.keyboard.press('Escape');
  await sideMenu.waitFor({ state: 'hidden' });
  assert.match(await sideTrigger.innerText(), /Beta/); assert.match(await mainTrigger.innerText(), /Alpha/);
  await sideTrigger.click(); await sideMenu.waitFor();
  assert.match(await sideMenu.locator('.model-choice.selected').innerText(), /Beta/);
  await sideTrigger.click(); await sideMenu.waitFor({ state: 'hidden' });
  await mainTrigger.click(); await mainMenu.waitFor(); await mainTrigger.click(); await mainMenu.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1000, height: 620 }); await sideTrigger.click(); await sideMenu.waitFor();
  const menu = await sideMenu.boundingBox(), pane = await page.locator('.temporary-chat').boundingBox(), composer = await page.locator('.temporary-chat .composer').boundingBox();
  assert.ok(menu.x >= pane.x && menu.x + menu.width <= pane.x + pane.width + 1);
  assert.ok(menu.y >= pane.y && menu.y + menu.height < composer.y);
  await search.press('Escape');
  await page.goto(server.resolvedUrls.local[0] + '?modelCount=7');
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await mainTrigger.click(); await mainMenu.waitFor();
  assert.equal(await mainMenu.locator('.model-choice').count(), 7);
  assert.equal(await mainMenu.locator('.model-menu-topbar, .model-menu-search').count(), 0, 'fewer than eight models hides the entire header');
  await mainMenu.screenshot({ path: '.tmp/qa/model-picker-seven.png' });
  await page.keyboard.press('Escape');
  assert.equal(await mainMenu.isVisible(), false);
  assert.equal(await page.evaluate(() => window.pickerCalls.some(c => ['send', 'push', 'commit'].includes(c.action || c.operation))), false);
  assert.deepEqual(errors, []);
  console.log('PASS shared picker visual parity, main-only reasoning controls, side-only persistence, keyboard/IME/disabled guards, trigger toggle/focus restore and compact bounds; no model calls.');
} finally { await browser.close(); await server.httpServer.close(); }

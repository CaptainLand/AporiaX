import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  // Vite injects dev styles inline; the packaged app's CSP intentionally blocks
  // those injections. Match the existing dev-browser tests, not production CSP.
  const page = await browser.newPage({ viewport: { width: 1450, height: 950 }, bypassCSP: true });
  page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(60000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('aporiax.language.v1', new URLSearchParams(location.search).get('lang') || 'zh-CN');
    localStorage.setItem('aporiax.theme.v2', 'dark');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'customization', welcomeDismissed: true }));
    const task = { id: 'customization', title: '主题测试', workspaceName: '演示', workspacePath: 'D:/Fixture', createdAt: '2026-10-18T00:00:00Z', providerId: 'fixture', modelId: 'fixture', messages: [
      { id: 'u', role: 'user', content: '合成消息' },
      { id: 'a', role: 'assistant', status: 'completed', content: '### 界面预览\n\n普通正文与代码。\n\n```js\nconst theme = "AporiaX";\n```', changes: [{ path: 'demo.js', created: true, beforeMissing: true, beforeContent: '', afterContent: 'new', additions: 1, deletions: 0 }], witness: { status: 'completed', records: [], revision: 1, counters: { activeAgents: 0 } } },
    ] };
    let record = JSON.parse(localStorage.getItem('fixture.theme') || 'null');
    const subscribers = new Set();
    window.desktop = {
      theme: { set: async input => { window.caption = input; } },
      appearance: {
        subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn); },
        request: async input => {
          const { defaultAppearance, validateAppearance, validateTheme } = await import('/shared/appearance.js');
          record ||= { ...defaultAppearance(), themes: [{ id: 'theme-11111111-1111-4111-8111-111111111111', name: '旧版高级主题', gradient: { enabled: true, start: '#13271d', end: '#273a53', angle: 90, strength: .65 }, base: 'dark', colors: { accent: '#398ad6', background: '#0f1114', panel: '#14161a', text: '#eaedf2', secondary: '#b9a4ed', quota: '#5cd4a8', icon: '#e8b46d' }, components: { composer: { radius: 0, background: '#20241f' } }, regions: { sidebar: '#17201c' }, shape: { radius: 18 }, source: 'manual', createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z', backgroundId: null, backgroundStrength: .12 }] };
          if (input.action === 'get') return structuredClone(record);
          if (input.revision !== record.revision) throw Error('APPEARANCE_CHANGED');
          let next = structuredClone(record);
          if (input.action === 'preferences') {
            if ('enabled' in input) next.enabled = input.enabled;
            if ('selectedId' in input) next.selectedId = input.selectedId;
            if ('base' in input) next.base = input.base;
            if (!next.enabled) next.selectedId = null;
            if (next.selectedId) next.base = next.themes.find(t => t.id === next.selectedId).base;
          } else if (input.action === 'save') {
            const theme = { ...validateTheme(input.theme), id: input.id || `theme-${crypto.randomUUID()}`, source: 'manual', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
            next.themes = [...next.themes.filter(t => t.id !== theme.id), theme]; next.selectedId = null;
          } else if (input.action === 'delete') {
            next.themes = next.themes.filter(t => t.id !== input.id); if (next.selectedId === input.id) next.selectedId = null;
          } else throw Error('Unexpected fixture request');
          next.revision++; record = validateAppearance(next); localStorage.setItem('fixture.theme', JSON.stringify(record)); subscribers.forEach(fn => fn(structuredClone(record))); return structuredClone(record);
        },
      },
      providers: { list: async () => [{ id: 'fixture', name: 'Demo', models: [{ id: 'fixture', name: 'Demo' }] }] },
      account: { get: async () => ({ status: 'authenticated', profile: { id: 'fixture-user', displayName: '演示账户', email: 'demo@example.invalid' }, quota: { remainingRatio: .72, cycleEnd: '2026-10-25T00:00:00Z' } }), getRequestHistory: async () => ({ items: [], nextCursor: null, sampledAt: new Date().toISOString() }) }, tasks: { load: async () => [task], save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] }, sandbox: { status: async () => ({ localAvailable: true }) },
      workbench: { subscribe: () => () => {}, request: async input => input.action === 'list' ? [] : true },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  const open = async () => { await page.getByRole('button', { name: '打开 AporiaX 设置', exact: true }).click(); await page.getByRole('button', { name: '个性化', exact: true }).click(); };
  await open();
  await page.getByRole('switch', { name: '开启自定义外观' }).click();
  await page.getByRole('button', { name: '应用主题 旧版高级主题', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.customTheme);
  const check = (selector, key) => page.locator(selector).first().evaluate((el, key) => getComputedStyle(el)[key], key);
  assert.equal(await check('.sidebar', 'backgroundColor'), 'rgb(20, 22, 26)');
  assert.equal(await check('.thread-body', 'backgroundImage'), 'none');
  assert.notEqual(await check('.composer', 'borderRadius'), '0px');
  assert.equal(await page.locator('html').getAttribute('data-theme-gradient'), null);
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--theme-panel-gradient')), '');
  await page.getByRole('button', { name: '编辑主题 旧版高级主题', exact: true }).click();
  assert.equal(await page.getByRole('switch', { name: '开启整体渐变' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '组件细节', exact: true }).count(), 0);
  await page.getByLabel('主题主色', { exact: true }).fill('#31c48d');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  assert.equal(await check('.thread-body', 'backgroundImage'), 'none');
  await page.getByRole('button', { name: '保存并应用', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--accent-9') === '#31c48d');
  assert.match(await check('.local-account-quota-track i', 'backgroundImage'), /rgb\(49, 196, 141\)/);
  const record = await page.evaluate(() => window.desktop.appearance.request({ action: 'get' }));
  assert.equal(record.themes[0].gradient.enabled, true, 'Archived gradient is retained, not rendered');
  assert.equal(record.themes[0].components.composer.radius, 0);
  await page.reload();
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.waitForFunction(() => document.documentElement.dataset.customTheme);
  assert.equal(await check('.thread-body', 'backgroundImage'), 'none');
  await open();
  await page.getByRole('button', { name: '复制主题 旧版高级主题', exact: true }).click();
  await page.setViewportSize({ width: 700, height: 850 });
  assert.equal(await page.locator('.personalization-settings').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  await mkdir('.tmp/qa', { recursive: true }); await page.screenshot({ path: '.tmp/qa/basic-appearance-restored.png' });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '恢复默认外观', exact: true }).click();
  await page.waitForFunction(() => !document.documentElement.dataset.customTheme);
  assert.equal((await page.evaluate(() => window.desktop.appearance.request({ action: 'get' }))).themes.length, 1);
  assert.deepEqual(errors, []);
  console.log('PASS browser: original basic editor restored, no gradient/advanced controls, retired settings inactive but preserved, primary quota, preview/save/reload/copy/narrow/reset, no page errors.');
} finally { await browser.close(); await server.close(); }

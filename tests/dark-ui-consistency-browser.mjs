import assert from 'node:assert/strict';
import { createServer, preview } from 'vite';
import { chromium } from 'playwright-core';
import { defaultRoleSettings } from '../shared/professional-roles.js';

const production = process.argv.includes('--production');
const server = production ? await preview({ preview: { host: '127.0.0.1', port: 0 } })
  : await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
if (!production) await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const errors = [];
const watch = page => { page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message)); };
const sameColor = async (locator, variable) => locator.evaluate((element, variable) => {
  const probe = document.createElement('span'); probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(variable);
  element.append(probe); const expected = getComputedStyle(probe).color; probe.remove();
  return { actual: getComputedStyle(element).color, expected };
}, variable);

try {
  // Current renderer, not a standalone role component: prevent the about panel
  // from leaking into the professional-role page. All IPC is synthetic.
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, bypassCSP: !production });
    await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await context.addInitScript(({ theme, roles }) => {
      localStorage.clear(); localStorage.setItem('aporiax.language.v1', 'zh-CN'); localStorage.setItem('aporiax.theme.v2', theme);
      localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'theme-audit', welcomeDismissed: true }));
      const task = { id: 'theme-audit', title: '合成主题检查', workspaceName: 'Demo', workspacePath: 'D:/Demo', providerId: 'fixture', modelId: 'fixture-model', executionMode: 'safe', approvalMode: 'smart-auto', messages: [] };
      window.themeAuditCalls = [];
      window.desktop = {
        theme: { set: async () => {} }, account: { get: async () => ({ status: 'anonymous' }) },
        tasks: { load: async () => [task], save: async () => {}, diagnostics: async () => [] },
        providers: { list: async () => [{ id: 'fixture', name: '演示模型服务', models: [{ id: 'fixture-model', name: '演示模型' }] }] },
        harness: { onEvent: () => () => {}, recoverableRuns: async () => [] }, sandbox: { status: async () => ({ localAvailable: true }) },
        agentProfiles: { get: async () => roles },
        core: { skills: async () => ({ skills: [] }), capabilities: async () => ({ capabilities: [] }) },
        workbench: { subscribe: () => () => {}, request: async input => { window.themeAuditCalls.push(input); return input.action === 'list' ? [] : true; } },
      };
    }, { theme, roles: defaultRoleSettings() });
    const page = await context.newPage(); watch(page);
    await page.goto(base);
    await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
    if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
    await page.getByRole('button', { name: '打开任务设置', exact: true }).click();
    const chips = page.locator('.settings-panel .sandbox-constraints.fallback span');
    await chips.first().waitFor(); assert.equal(await chips.count(), 4);
    for (const chip of await chips.all()) {
      const { actual, expected } = await sameColor(chip, '--accent-11');
      assert.equal(actual, expected, `${theme}: execution facts are blue information, not amber warnings`);
    }
    await page.getByRole('button', { name: '关闭设置面板', exact: true }).click();
    await page.getByRole('button', { name: '打开 AporiaX 设置', exact: true }).click();
    const nav = page.getByRole('navigation', { name: '设置分类' });
    await nav.getByRole('button', { name: '专业角色', exact: true }).click();
    await page.locator('.professional-roles').waitFor();
    assert.equal(await page.locator('.application-about').count(), 0, `${theme}: role settings do not mount About`);
    await nav.getByRole('button', { name: '通用', exact: true }).click();
    assert.equal(await page.locator('.professional-roles').count(), 0);
    assert.equal(await page.locator('.application-about').count(), 0);
    await nav.getByRole('button', { name: '关于', exact: true }).click();
    await page.locator('.application-about').waitFor();
    assert.equal(await page.locator('.application-about').count(), 1);
    assert.equal(await page.locator('.professional-roles').count(), 0);
    assert.equal(await page.evaluate(() => window.themeAuditCalls.some(input => /run|send|write|install/.test(input.action))), false);
    await context.close();
  }

  if (!production) {
    const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    const page = await context.newPage(); watch(page);
    await page.goto(base + 'tests/fixtures/extension-library.html?theme=dark');
    await page.getByRole('button', { name: '已安装', exact: true }).click();
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await page.locator('.extensions-mcp-form').waitFor();
    const checkOverlay = async (selector, native = false) => {
      const palette = await page.locator(selector).evaluate((element, native) => {
        const root = getComputedStyle(document.documentElement);
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const normalize = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
        return { actual: normalize(getComputedStyle(element, native ? '::backdrop' : null).backgroundColor), expected: normalize(root.getPropertyValue('--bg-app')) };
      }, native);
      assert(palette.actual.slice(0, 3).every((value, index) => Math.abs(value - palette.expected[index]) <= 3), 'Dark overlays do not brighten the application');
      assert(Math.abs(palette.actual[3] - 204) <= 1, 'Consistent 80% dark overlay');
    };
    await checkOverlay('.extensions-form-backdrop');
    // Extension details share this exact backdrop selector; inspect without
    // fetching a remote catalog entry or installing an extension.
    await page.locator('.extensions-form-backdrop').evaluate(element => element.classList.add('extension-detail-backdrop'));
    await checkOverlay('.extension-detail-backdrop');
    await page.goto(base + 'tests/fixtures/terminal-v2.html');
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await page.getByRole('button', { name: '新建测试终端', exact: true }).click();
    await page.getByRole('button', { name: '终端菜单', exact: true }).click();
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    await page.locator('.side-chat-dialog[open]').waitFor();
    await checkOverlay('.side-chat-dialog', true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.side-chat-dialog[open]').count(), 0, 'Native dialog dismissal stays intact');
    const colors = await page.evaluate(() => {
      const probes = [];
      for (const theme of ['light', 'dark']) {
        document.documentElement.dataset.theme = theme;
        const values = {};
        for (const [parent, child] of [['side-chat', 'hljs-literal'], ['side-chat', 'hljs-keyword'], ['workbench-markdown', 'hljs-comment']]) {
          const wrapper = document.createElement('div'); wrapper.className = parent;
          const code = document.createElement('pre'), span = document.createElement('span'); span.className = child; span.textContent = 'style probe'; code.append(span); wrapper.append(code); document.body.append(wrapper);
          values[parent + '/' + child] = getComputedStyle(span).color; wrapper.remove();
        }
        probes.push(values);
      }
      return probes;
    });
    assert.equal(colors[1]['side-chat/hljs-literal'], colors[1]['side-chat/hljs-keyword'], 'Dark literals use the dark keyword palette');
    assert.notEqual(colors[0]['side-chat/hljs-literal'], colors[1]['side-chat/hljs-literal']);
    assert.notEqual(colors[0]['workbench-markdown/hljs-comment'], colors[1]['workbench-markdown/hljs-comment'], 'Markdown comments adapt to the theme');
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(`PASS dark UI consistency${production ? ' (production renderer)' : ''}: blue informational chips, isolated role/about pages${production ? '' : ', dark shared overlays and code highlight adaptation'}; no real IPC or external requests.`);
} finally { await browser.close(); await server.close(); }

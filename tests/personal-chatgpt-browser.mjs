import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, bypassCSP: true });
  page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.clear(); localStorage.setItem('aporiax.language.v1', 'zh-CN'); localStorage.setItem('aporiax.theme.v2', 'dark');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'personal-fixture', welcomeDismissed: true }));
    const state = window.personalFixture = { status: { available: true, status: 'disconnected', models: [], lastError: '' }, calls: [] };
    const model = { id: 'personal-fixture-model', name: 'Personal model fixture', shortName: 'Personal model fixture', supportsTools: true, supportsThinking: true,
      thinkingMode: 'personal-chatgpt', supportedEfforts: ['low', 'high', 'xhigh'], defaultEffort: 'high' };
    const provider = () => ({ id: 'chatgpt-personal', name: '个人 ChatGPT', managed: true, kind: 'chatgpt-personal', source: 'chatgpt-personal', billing: 'personal-chatgpt-plan',
      disabled: state.status.status !== 'connected', models: state.status.models });
    const task = { id: 'personal-fixture', title: '个人套餐接入测试', workspacePath: '', providerId: 'chatgpt-personal', modelId: model.id, messages: [{ id: 'fixture-message', role: 'assistant', status: 'completed', content: '界面合成测试，不是真实账号。' }] };
    window.desktop = {
      theme: { set: async () => {} }, account: { get: async () => ({ status: 'anonymous' }) },
      providers: { list: async () => [provider()] },
      personalChatGPT: {
        status: async () => structuredClone(state.status),
        startLogin: async () => { state.calls.push('startLogin'); return state.status = { ...state.status, status: 'authorizing' }; },
        cancel: async () => { state.calls.push('cancel'); return state.status = { ...state.status, status: 'disconnected' }; },
        signOut: async () => { state.calls.push('signOut'); return state.status = { available: true, status: 'disconnected', models: [], lastError: '' }; },
        refreshModels: async () => { state.calls.push('refreshModels'); return state.status = { ...state.status, models: [model] }; },
      },
      tasks: { load: async () => [task], save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] }, sandbox: { status: async () => ({ localAvailable: true }) },
      workbench: { subscribe: () => () => {}, request: async input => input.action === 'list' ? [] : true },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.assistant-message').waitFor();
  const open = async () => {
    await page.getByRole('button', { name: '打开 AporiaX 设置', exact: true }).click();
    await page.getByRole('button', { name: '模型与 API', exact: true }).click();
    await page.locator('.personal-chatgpt-panel').waitFor();
  };
  await open();
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await page.getByRole('button', { name: '取消连接', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await page.evaluate(() => { window.personalFixture.status = { ...window.personalFixture.status, status: 'connected', planUsageGranted: true, account: { email: 'ui-fixture@example.invalid' } }; });
  await page.locator('.personal-chatgpt-identity').waitFor();
  await page.locator('.personal-chatgpt-models strong').waitFor();
  assert.equal(await page.locator('.personal-chatgpt-models strong').innerText(), 'Personal model fixture');
  assert.match(await page.locator('.personal-chatgpt-models').innerText(), /待首次请求验证/);
  assert.equal(await page.locator('.personal-chatgpt-panel input[type=password]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '添加 Provider', exact: true }).count(), 0);
  await mkdir('.tmp/personal-chatgpt-qa', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.locator('.application-settings-modal').screenshot({ path: `.tmp/personal-chatgpt-qa/connected-fixture-${theme}.png` });
  }
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.locator('.composer .model-trigger').click();
  const menu = page.getByRole('dialog', { name: '选择模型', exact: true });
  assert.match(await menu.innerText(), /个人 ChatGPT/); assert.match(await menu.innerText(), /不使用 Cloud/);
  assert.equal(await menu.getByRole('button', { name: /Personal model fixture/ }).isDisabled(), false);
  assert.doesNotMatch(await menu.innerText(), /你的 Provider|你的 API/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '切换思考强度', exact: true }).click();
  const slider = page.getByRole('slider', { name: '思考强度', exact: true });
  assert.equal(await slider.getAttribute('max'), '2');
  await page.keyboard.press('Escape');
  await open();
  await page.getByRole('button', { name: '断开账号', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).waitFor();
  assert.equal(await page.locator('.personal-chatgpt-identity').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS browser: personal tab, consent/cancel/completion, current catalog, unverified labels, isolated model group and three advertised efforts, disconnect, light/dark connected-state screenshots. Mock account only.');
} finally { await browser.close(); await server.close(); }

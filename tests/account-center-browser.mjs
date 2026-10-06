import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer, preview } from 'vite';
import { chromium } from 'playwright-core';
import { measureTextContrast } from './text-contrast.js';
const baseline = process.env.ACCOUNT_THEME_BASELINE_ROOT;
const production = process.env.ACCOUNT_THEME_PRODUCTION === '1';
const server = production
  ? await preview({ preview: { host: '127.0.0.1', port: 0, open: false } })
  : await createServer({ ...(baseline ? { root: baseline } : {}), server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
if (!production) await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 840 }, bypassCSP: !production });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('aporiax.language.v1', 'zh-CN');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ welcomeDismissed: true }));
    // Even a stale opt-in and a server advertising support must stay offline.
    const account = { status: 'authenticated', profile: { displayName: '测试账号', email: 'test@example.invalid' }, quota: { remainingRatio: .8 }, models: [{ displayName: 'DeepSeek V4.1 Flash' }], device: { name: '测试电脑', remoteEnabled: true }, capabilities: { remote: { supported: true } }, remoteFiles: { enabled: true } };
    window.centerCalls = 0; window.centerFailure = false; window.mobileCalls = 0; window.avatarFixture = account;
    window.desktop = {
      theme: { set: async () => {} }, providers: { list: async () => [{ id: 'own', name: '自己的 API', models: [{ id: 'own-model', name: 'Own model' }] }] },
      account: { get: async () => account, refresh: async () => account, signOut: async () => ({ status: 'anonymous' }), openCenter: async () => { window.centerCalls++; if (window.centerFailure) throw Error('APORIAX_PRIVATE_CONNECTION_FAILED'); return { opened: true }; }, syncTasks: async () => { window.mobileCalls++; return {}; }, remoteCommands: async () => { window.mobileCalls++; return []; }, claimRemoteCommand: async () => { window.mobileCalls++; } },
      tasks: { load: async () => [], save: async () => {} }, harness: { onEvent: () => () => {}, recoverableRuns: async () => [] },
      sandbox: { status: async () => ({ localAvailable: true }) },
      workbench: { request: async ({ action }) => action === 'list' ? [] : true, subscribe: () => () => {} },
      sideChat: { request: async () => ({ messages: [] }), subscribe: () => () => {} },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.local-account-profile').waitFor();
  await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
  await page.locator('#task-title').fill('账户与输入框主题测试');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  const draft = page.getByRole('textbox', { name: '任务输入', exact: true });
  const surface = () => draft.evaluate(el => ({ outline: getComputedStyle(el).outlineStyle, outlineWidth: getComputedStyle(el).outlineWidth, outlineColor: getComputedStyle(el).outlineColor }));
  await draft.click();
  const focused = await surface();
  if (baseline) assert.equal(focused.outlineWidth, '2px', 'Reproduce the unwanted mouse-click outline');
  else assert.equal(focused.outline, 'none', 'Mouse-clicking the composer must not show the global blue outline');
  await draft.fill('这段草稿在切换主题后仍应保留');
  await page.locator('.local-account-profile').click();
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#226d96'; ctx.fillRect(0,0,64,64);
    window.avatarFixture.profile.avatarDataUrl = canvas.toDataURL('image/webp');
    window.dispatchEvent(new Event('focus'));
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  assert.equal(await page.locator('.local-account-avatar img').count(), 0, 'Avatar presentation remains disabled, even if a stored profile has one');
  const footer = page.locator('.local-account-profile');
  const footerPercent = footer.locator('.local-account-quota-percent');
  if (!baseline) {
    assert.equal(await footer.locator('.local-account-avatar, img, svg').count(), 0, 'Signed-in footer is text-only');
    await footerPercent.filter({ hasText: '80%' }).waitFor();
  }
  const center = page.getByRole('button', { name: '账户中心', exact: true });
  await center.waitFor();
  assert.equal(await page.locator('.local-account-remote').count(), 0, 'Offline mobile controls must not render');
  assert.equal(await page.locator('.local-account-local-note--security').count(), 0);
  assert.doesNotMatch(await page.locator('.local-account-popover').innerText(), /手机|Mobile|Read-only mobile/);
  await page.waitForTimeout(2200); // Covers the initial sync and command timers.
  assert.equal(await page.evaluate(() => window.mobileCalls), 0, 'Offline companion must not poll or prepare uploads');
  await mkdir('.tmp/qa', { recursive: true });
  let baselineMismatch = false;
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) {
      await page.locator('.theme-toggle').click();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    }
    if (!await page.locator('.local-account-popover').count()) await page.locator('.local-account-profile').click();
    const colors = await page.evaluate(() => ({
      menu: getComputedStyle(document.querySelector('.local-account-popover')).backgroundColor,
      sidebar: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
      name: getComputedStyle(document.querySelector('.local-account-popover-head strong')).color,
    }));
    if (baseline) baselineMismatch ||= colors.menu !== colors.sidebar;
    else assert.equal(colors.menu, colors.sidebar, `${theme}: account popup must use the same theme surface as the sidebar`);
    const selectors = ['.local-account-profile strong', '.local-account-profile small', '.local-account-quota-percent', '.local-account-popover-head strong', '.local-account-popover-head small', '.local-account-connected', '.local-account-quota-card strong', '.local-account-quota-card > div > span', '.local-account-meta span', '.local-account-remote strong', '.local-account-remote small', '.local-account-local-note', '.local-account-actions button'];
    let min = Infinity;
    for (const selector of selectors) {
      for (const element of await page.locator(selector).all()) {
        const result = await element.evaluate(measureTextContrast); min = Math.min(min, result.ratio);
        if (!baseline) assert.ok(result.ratio >= 4.5, `${theme} ${selector}: ${JSON.stringify(result)}`);
      }
    }
    await page.screenshot({ path: `.tmp/qa/account-center-${baseline ? 'baseline-' : production ? 'production-' : ''}${theme}.png` });
    if (!baseline) {
      const layout = await footer.evaluate(el => {
        const copy = el.querySelector('.local-account-profile-copy');
        const track = el.querySelector('.local-account-quota-track');
        return {
          nameSize: getComputedStyle(el.querySelector('strong')).fontSize,
          labelSize: getComputedStyle(el.querySelector('small')).fontSize,
          percentageSize: getComputedStyle(el.querySelector('.local-account-quota-percent')).fontSize,
          trackWidth: track.getBoundingClientRect().width,
          copyWidth: copy.getBoundingClientRect().width,
          trackHeight: track.getBoundingClientRect().height,
          gradient: getComputedStyle(track.querySelector('i')).backgroundImage,
        };
      });
      assert.equal(layout.nameSize, '15px'); assert.equal(layout.labelSize, '12px'); assert.equal(layout.percentageSize, '12px');
      assert.ok(Math.abs(layout.trackWidth - layout.copyWidth) <= 1, 'Quota bar spans the entire text column');
      assert.equal(layout.trackHeight, 6); assert.match(layout.gradient, /linear-gradient/);
      await footer.screenshot({ path: `.tmp/qa/account-footer-${production ? 'production-' : ''}${theme}.png` });
      console.log(`PASS: ${theme} text-only footer; 15px name, 12px quota, full-width ${layout.trackWidth}px gradient bar.`);
    }
    console.log(`${baseline ? 'BASELINE' : 'PASS'}: ${theme} account menu contrast ${min.toFixed(2)}:1; ${JSON.stringify(colors)}`);
    // Tab focus is still visible on actionable controls. Only the textarea's
    // generic outline is suppressed; it keeps a neutral focus-within border.
    await draft.click();
    if (!baseline) assert.equal((await surface()).outline, 'none', `${theme}: composer click outline`);
    await page.keyboard.press('Tab');
    const keyboard = await page.evaluate(() => ({ tag: document.activeElement.tagName, focusVisible: document.activeElement.matches(':focus-visible'), outline: getComputedStyle(document.activeElement).outlineStyle }));
    assert.equal(keyboard.tag, 'BUTTON'); assert.equal(keyboard.focusVisible, true); assert.equal(keyboard.outline, 'solid');
    assert.equal(await draft.inputValue(), '这段草稿在切换主题后仍应保留');
  }
  if (!await page.locator('.local-account-popover').count()) await page.locator('.local-account-profile').click();
  if (baseline) {
    assert.equal(baselineMismatch, true, 'Reproduce account menu/side panel palette mismatch');
    console.log(`REPRODUCED RC3: composer outline ${focused.outlineWidth} ${focused.outlineColor}, mismatched account surface; button keyboard focus retained.`);
  }
  if (!baseline) {
    for (const [ratio, expected] of [[0, 0], [.005, 1], [.5, 50], [1, 100], [1.2, 100], [-.1, 0]]) {
      await page.evaluate(ratio => { window.avatarFixture.quota = { remainingRatio: ratio }; }, ratio);
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.waitForFunction(expected => document.querySelector('.local-account-quota-percent')?.textContent === `${expected}%`, expected);
      assert.equal(await footer.locator('.local-account-quota-track i').evaluate(el => el.style.width), `${expected}%`);
      assert.equal(await page.locator('.local-account-quota-card [role="progressbar"]').getAttribute('aria-valuenow'), String(expected));
    }
    await page.evaluate(() => { window.avatarFixture.profile.displayName = '这是一个很长的账户名字'.repeat(6); });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.local-account-profile strong')?.textContent.length > 50);
    const longName = await footer.locator('strong').evaluate(el => ({ clipped: el.scrollWidth > el.clientWidth, overflow: getComputedStyle(el).textOverflow }));
    assert.equal(longName.clipped, true); assert.equal(longName.overflow, 'ellipsis');
    await page.evaluate(() => { window.avatarFixture.profile.displayName = '测试账号'; window.avatarFixture.quota = { remainingRatio: .8 }; });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.local-account-quota-percent')?.textContent === '80%');
    console.log('PASS: zero, low, partial and full quota; out-of-range ratios clamped; long names ellipsized.');
  }
  await center.click(); assert.equal(await page.evaluate(() => window.centerCalls), 1);
  await page.evaluate(() => { window.centerFailure = true; });
  await center.click(); await page.getByRole('alert').filter({ hasText: '暂时无法连接私有 Cloud' }).waitFor();
  assert.equal(await center.isEnabled(), true);
  await page.evaluate(() => { window.centerFailure = false; });
  await center.click(); assert.equal(await page.getByRole('alert').count(), 0);
  await page.setViewportSize({ width: 800, height: 600 });
  await center.scrollIntoViewIfNeeded();
  const bounds = await page.locator('.local-account-popover').boundingBox(); assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 600);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  assert.equal(await page.locator('.local-account-avatar img').count(), 0, 'Avatar cleared on logout');
  assert.equal(await page.locator('.local-account-web').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: account center click, failure feedback and retry, compact-window scrolling, signed-out state; zero uncaught browser errors.');
} finally { await browser.close(); await server.close(); }

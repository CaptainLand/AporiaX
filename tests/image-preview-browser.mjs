import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } }); await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, bypassCSP: true });
  page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(60000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear();
    window.imageMotions = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      if (this.classList.contains('image-preview-photo')) window.imageMotions.push({ frames, options });
      return animate.call(this, frames, options);
    };
    const query = new URLSearchParams(location.search);
    localStorage.setItem('aporiax.language.v1', query.get('lang') || 'zh-CN');
    localStorage.setItem('aporiax.theme.v2', query.get('theme') || 'dark');
    localStorage.setItem('aporiax.session-ui.v1', JSON.stringify({ taskId: 'images', welcomeDismissed: true }));
    const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 1000;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#193d38'; ctx.fillRect(0, 0, 1600, 1000); ctx.fillStyle = '#b6d8cc'; ctx.fillRect(90, 110, 660, 560);
    const image = canvas.toDataURL('image/png'); window.fixtureImage = image;
    const task = { id: 'images', title: '图片查看测试', workspaceName: '演示', workspacePath: 'D:/Fixture', providerId: 'fixture', modelId: 'fixture', createdAt: '2026-10-19T00:00:00Z', messages: [
      { id: 'u', role: 'user', content: '图片附件', attachments: [{ id: 'image', kind: 'image', name: 'private-shot.png', dataUrl: image }, { id: 'doc', kind: 'document', name: 'notes.txt', format: 'TXT' }] },
      { id: 'a', role: 'assistant', status: 'completed', content: `![回答图片](/fixture-answer${query.has('broken') ? '-missing' : ''}.png)` },
    ] };
    window.sidebarCalls = [];
    window.desktop = {
      providers: { list: async () => [{ id: 'fixture', name: 'Demo', models: [{ id: 'fixture', name: 'Demo', supportsImages: true }] }] },
      account: { get: async () => ({ status: 'anonymous' }) }, tasks: { load: async () => [task], save: async () => {} },
      harness: { onEvent: () => () => {}, recoverableRuns: async () => [] }, sandbox: { status: async () => ({ localAvailable: true }) },
      workbench: { subscribe: () => () => {}, request: async input => { window.sidebarCalls.push(input); return input.action === 'list' ? [] : true; } },
    };
  });
  await page.route('**/fixture-answer.png', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64') }));
  await page.goto(server.resolvedUrls.local[0]);
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  const thumbnail = page.locator('.message-attachment-grid img'); await thumbnail.waitFor();
  assert.equal(await page.locator('.message-attachment-grid figcaption').count(), 0);
  assert.equal(await page.locator('.message-attachment-grid').innerText(), 'notes.txt\nTXT · 已解析');
  const bounds = await page.locator('.thread').boundingBox();
  await thumbnail.click();
  const dialog = page.getByRole('dialog', { name: '查看图片', exact: true }); await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector('.image-preview-dialog img')?.naturalWidth === 1600);
  assert.equal(await page.locator('.workbench-shell').count(), 0);
  assert.deepEqual(await page.locator('.thread').boundingBox(), bounds);
  const photo = dialog.locator('img');
  await photo.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
  const opening = await page.evaluate(() => window.imageMotions[0]);
  assert.match(opening.frames[0].transform, /translate.*scale/); assert.equal(opening.options.duration, 260);
  assert.equal(await dialog.locator('button,header,.image-surface-toolbar').count(), 0, 'photo has no visible chrome');
  assert.equal(await dialog.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.match(await dialog.evaluate(el => getComputedStyle(el, '::backdrop').backdropFilter), /blur\(12px\)/);
  const fitImage = await photo.boundingBox();
  assert(fitImage.width <= 1304 && fitImage.height <= 804);
  await photo.click();
  await page.waitForFunction(() => document.querySelector('.image-preview-photo')?.getAttribute('data-zoomed') === 'true');
  await page.waitForTimeout(210);
  const zoomedImage = await photo.boundingBox(); assert(zoomedImage.width > fitImage.width * 1.9);
  const initialTransform = await photo.evaluate(el => el.style.transform);
  await page.mouse.move(700, 450); await page.mouse.down(); await page.mouse.move(820, 520, { steps: 8 }); await page.mouse.up();
  assert.notEqual(await photo.evaluate(el => el.style.transform), initialTransform);
  assert.equal(await photo.getAttribute('data-zoomed'), 'true', 'drag release must not toggle zoom');
  assert.equal(await dialog.count(), 1, 'drag release must not close preview');
  await photo.click({ position: { x: 700, y: 450 } });
  await page.waitForFunction(() => !document.querySelector('.image-preview-photo')?.hasAttribute('data-zoomed'));
  await page.waitForTimeout(210);
  await page.mouse.move(700, 450); await page.mouse.wheel(0, -200);
  await page.waitForFunction(() => document.querySelector('.image-preview-photo')?.hasAttribute('data-zoomed'));
  await page.keyboard.press('0'); await page.waitForTimeout(210);
  await page.keyboard.press('+');
  assert.equal(await photo.getAttribute('data-zoomed'), 'true');
  await page.keyboard.press('0'); await page.waitForTimeout(210);
  await mkdir('.tmp/qa', { recursive: true }); await page.screenshot({ path: '.tmp/qa/image-dialog-dark.png' });
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  assert.equal(await thumbnail.evaluate(el => el === document.activeElement), true);
  await thumbnail.focus(); await page.keyboard.press('Enter'); await dialog.waitFor();
  await page.mouse.click(5, 5); await dialog.waitFor({ state: 'detached' });
  const answer = page.locator('.markdown-message img'); await answer.click(); await dialog.waitFor();
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  const png = await page.evaluate(() => window.fixtureImage.split(',')[1]);
  await page.locator('input[accept*="image/png"]').setInputFiles({ name: 'draft-secret.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  const draft = page.locator('.composer-attachments figure'); await draft.waitFor();
  assert.equal(await draft.locator('figcaption').count(), 0); assert.equal(await draft.getAttribute('draggable'), 'true');
  await draft.locator('img').click(); await dialog.waitFor();
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  await draft.getByRole('button', { name: '移除 draft-secret.png', exact: true }).click(); assert.equal(await draft.count(), 0);
  assert.equal(await page.locator('.workbench-shell').count(), 0);
  assert.equal(await page.evaluate(() => window.sidebarCalls.some(call => /^new-|present|open/.test(call.action || ''))), false);
  await page.goto(server.resolvedUrls.local[0] + '?theme=light&lang=en');
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.message-attachment-grid img').click();
  const english = page.getByRole('dialog', { name: 'View image', exact: true }); await english.waitFor();
  assert.equal(await english.locator('button,header').count(), 0);
  assert.match(await english.evaluate(el => getComputedStyle(el, '::backdrop').backdropFilter), /blur/);
  await page.setViewportSize({ width: 600, height: 700 });
  await english.locator('img').evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
  await page.waitForTimeout(280);
  const rect = await english.boundingBox(); assert(rect.x >= 0 && rect.y >= 0 && rect.width <= 600 && rect.height <= 700);
  const narrowPhoto = await english.locator('img').boundingBox();
  assert(narrowPhoto.x >= 0 && narrowPhoto.y >= 0 && narrowPhoto.x + narrowPhoto.width <= 600 && narrowPhoto.y + narrowPhoto.height <= 700);
  await page.keyboard.press('Tab'); assert.equal(await english.evaluate(el => document.activeElement === el), true, 'focus remains inside chromeless dialog');
  await page.screenshot({ path: '.tmp/qa/image-dialog-light-narrow.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await english.locator('img').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  await page.keyboard.press('Escape'); await english.waitFor({ state: 'detached' });
  const motionsBefore = await page.evaluate(() => window.imageMotions.length);
  await page.locator('.message-attachment-grid img').click(); await english.waitFor();
  await page.waitForFunction(() => document.querySelector('.image-preview-photo')?.naturalWidth === 1600);
  assert.equal(await page.evaluate(() => window.imageMotions.length), motionsBefore, 'reduced-motion skips thumbnail flight');
  // Real touch events through Chromium exercise two fingers and pointer capture.
  const client = await page.context().newCDPSession(page);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 260, y: 350, id: 1 }, { x: 340, y: 350, id: 2 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 210, y: 350, id: 1 }, { x: 390, y: 350, id: 2 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await english.locator('img').getAttribute('data-zoomed'), 'true', 'pinch zooms without a trailing tap resetting it');
  assert.equal(await english.count(), 1);
  await page.keyboard.press('Escape'); await english.waitFor({ state: 'detached' });
  await page.route('**/fixture-answer-missing.png', route => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto(server.resolvedUrls.local[0] + '?theme=light&lang=en&broken=1');
  if (await page.locator('.ax-welcome__enter').isVisible()) await page.locator('.ax-welcome__enter').click();
  await page.locator('.markdown-message img').click(); await english.waitFor();
  await english.getByRole('alert').waitFor();
  await page.mouse.click(5, 5); await english.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('PASS real app: image-only thumbnails, document names retained, chromeless preview and blurred backdrop, click/wheel zoom, drag without accidental zoom/close, keyboard reset/zoom, Escape/backdrop/focus, draft/Markdown images, English/light/narrow/reduced motion, no sidebar or layout changes.');
} finally { await browser.close(); await server.close(); }

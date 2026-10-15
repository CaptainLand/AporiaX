import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/agent-artwork.html');
  await page.waitForFunction(() => window.artworkOffice && [...document.querySelectorAll('.agent-avatar img')].length === 7 && [...document.querySelectorAll('.agent-avatar img')].every(image => image.complete && image.naturalWidth > 0));
  await page.locator('.agent-avatar img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  assert.equal(await page.locator('.ao-scene').evaluate(element => getComputedStyle(element).opacity), '1', 'Visual QA must capture the visible scene');
  const models = await page.evaluate(() => window.artworkOffice.diagnostics().agentModels);
  assert.equal(models.lead, 'aporiax-folded-wing-v1');
  assert.deepEqual(models, { lead:'aporiax-folded-wing-v1', explore:'scout-v1', review:'sentry-v1', verify:'checko-v1', builder:'forge-v1', curator:'index-v1' }, 'Each team member gets its distinct approved model');
  await mkdir('.tmp/qa', { recursive: true });
  await page.screenshot({ path: '.tmp/qa/agent-artwork-office-day.png' });
  await page.evaluate(() => { window.artworkOffice.focus('lead'); window.artworkOffice.setPaused(true); });
  await page.screenshot({ path: '.tmp/qa/aporiax-3d-working-day.png' });
  for (const state of ['sleeping','offline','waiting','attention','error','working']) {
    await page.evaluate(state => window.artworkOffice.setStates(Object.fromEntries(Object.keys(window.artworkOffice.diagnostics().states).map(id=>[id,state]))), state);
    assert((await page.evaluate(() => Object.values(window.artworkOffice.diagnostics().states))).every(value=>value===state));
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; window.artworkOffice.setTheme('night'); });
  await page.screenshot({ path: '.tmp/qa/aporiax-3d-working-night.png' });
  await page.evaluate(() => window.artworkOffice.setStates({ lead: 'sleeping' }));
  await page.screenshot({ path: '.tmp/qa/aporiax-3d-sleeping-night.png' });
  await page.evaluate(() => window.artworkOffice.reset());
  await page.screenshot({ path: '.tmp/qa/team-mascots-office-night.png' });
  await page.setViewportSize({ width: 520, height: 800 });
  await page.locator('.ao-scene canvas').waitFor();
  assert.equal(await page.locator('.agent-label').count(), 6);
  await page.evaluate(() => window.artworkOffice.destroy());
  assert.equal(await page.locator('.ao-scene canvas, .agent-label, .sleep-bubble').count(), 0, 'Scene and overlays disposed');
  assert.deepEqual(errors, []);
  console.log('PASS approved local portraits + real WebGL: all six distinct models, working/sleeping/offline/waiting/attention/error, day/night, narrow viewport and disposal.');
} finally { await browser.close(); await server.close(); }

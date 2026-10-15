import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const origin = 'https://101.43.44.160';
const download = origin + '/downloads/AporiaX-Beta-Portable-1.0.0-preview.2.beta.1-x64.exe';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const context = await browser.newContext();
  for (const [path, expected] of [['/', 200], ['/api/beta/status', 200], ['/api/me', 401], ['/gateway/v1/capabilities', 401], ['/.env', 404], ['/api/admin', 404]]) {
    const response = await context.request.get(origin + path);
    assert.equal(response.status(), expected, path);
    const headers = response.headers();
    assert.equal(headers['x-content-type-options'], 'nosniff', path);
    assert.equal(headers['x-frame-options'], 'DENY', path);
    assert.match(headers['content-security-policy'], /script-src 'self';/, path);
  }
  const file = await context.request.head(download);
  assert.equal(file.status(), 200);
  assert.ok(Number(file.headers()['content-length']) > 100_000_000);
  assert.equal(file.headers()['x-frame-options'], 'DENY');
  console.log('PASS common security headers on Web, API, Gateway, downloads and denied routes');
  for (const badOrigin of ['https://attacker.invalid', 'null', 'http://101.43.44.160']) {
    const response = await context.request.get(origin + '/api/beta/status', { headers: { Origin: badOrigin } });
    assert.equal(response.status(), 403, badOrigin);
  }
  assert.equal((await context.request.get(origin + '/api/beta/status', { headers: { Origin: origin } })).status(), 200);
  assert.equal((await context.request.get(origin + '/api/beta/status')).status(), 200);
  assert.equal((await context.request.post(origin + '/api/auth/refresh', { headers: { Origin: 'https://attacker.invalid' }, data: {} })).status(), 403);
  console.log('PASS same-origin and native clients allowed; untrusted browser origins rejected before auth');
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('aporia-language', 'zh');
    window.__cspViolations = [];
    window.addEventListener('securitypolicyviolation', event => window.__cspViolations.push({ directive: event.effectiveDirective, uri: event.blockedURI }));
  });
  for (const path of ['/', '/account', '/guide/']) {
    assert.equal((await page.goto(origin + path)).status(), 200);
    if (path === '/') await page.locator('#download').scrollIntoViewIfNeeded();
    if (path === '/account') await page.locator('.account-gate').waitFor();
    await page.waitForLoadState('networkidle');
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), [], path + ': no legitimate resource blocked');
  }
  assert.deepEqual(errors, []);
  console.log('PASS enforced CSP: home, account login gate and guide render without blocked resources or uncaught errors');
} finally {
  await browser.close();
}

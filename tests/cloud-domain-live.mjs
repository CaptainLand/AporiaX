// Explicit, anonymous deployment smoke. No real credentials, OTPs, model calls,
// installation or server mutation. Invoke separately from offline tests.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import yaml from 'js-yaml';
import { buildDesktopAuthorizationUrl, createDesktopPkce } from '../electron/account/desktop-account-core.js';
const { accountWebUrl: origin, accountApiUrl, modelGatewayUrl } = JSON.parse(await readFile('config/cloud-endpoints.json', 'utf8'));
assert.equal(origin, 'https://aporiax.cloud');
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const context = await browser.newContext(); // Normal TLS validation; never ignore certificate errors.
  const checks = [[`${origin}/`, 200], [`${accountApiUrl}/beta/status`, 200], [`${accountApiUrl}/me`, 401], [`${modelGatewayUrl}/v1/capabilities`, 401], [`${origin}/.env`, 404], [`${accountApiUrl}/admin`, 404]];
  for (const [url, status] of checks) {
    const response = await context.request.get(url);
    assert.equal(response.status(), status, new URL(url).pathname);
    assert.equal(response.headers()['x-content-type-options'], 'nosniff');
    assert.equal(response.headers()['x-frame-options'], 'DENY');
    // Denied/nonexistent paths are static 404s, not authenticated API payloads.
    if (status !== 404 && (url.startsWith(accountApiUrl) || url.startsWith(modelGatewayUrl))) assert.match(response.headers()['cache-control'], /no-store/, new URL(url).pathname);
  }
  const sameOrigin = await context.request.get(`${accountApiUrl}/beta/status`, { headers: { Origin: origin } });
  assert.equal(sameOrigin.status(), 200); assert.equal(sameOrigin.headers()['access-control-allow-origin'], origin);
  const hostile = await context.request.get(`${accountApiUrl}/beta/status`, { headers: { Origin: 'https://attacker.invalid' } });
  assert.equal(hostile.status(), 403);
  const metadata = await context.request.get(`${origin}/downloads/latest.yml`); assert.equal(metadata.status(), 200);
  const release = yaml.load(await metadata.text());
  const asset = new URL(release.files[0].url, `${origin}/downloads/`); assert.equal(asset.origin, origin);
  const head = await context.request.head(asset.href); assert.equal(head.status(), 200);
  assert.equal(Number(head.headers()['content-length']), release.files[0].size);
  console.log(`PASS real HTTPS: account/gateway authentication gates, same-origin allowlist, internal path protection and mirror ${release.version}`);
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(new URL(request.url())));
  await page.route('**/v1/chat/completions', route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('aporia-language', 'en');
    window.cspViolations = [];
    window.addEventListener('securitypolicyviolation', event => window.cspViolations.push(event.effectiveDirective));
  });
  assert.equal((await page.goto(origin)).status(), 200);
  await page.waitForLoadState('networkidle'); assert.match(await page.title(), /AporiaX/);
  assert.equal((await page.goto(`${origin}/account`)).status(), 200);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('textbox', { name: /Email/i }).waitFor();
  assert.equal(new URL(page.url()).origin, origin);
  const pkce = createDesktopPkce();
  const auth = buildDesktopAuthorizationUrl({ webBaseUrl: origin, redirectUri: 'http://127.0.0.1:49152/callback', state: pkce.state, codeChallenge: pkce.codeChallenge, deviceName: 'Domain smoke fixture', appVersion: '1.0.0-rc.4' });
  assert.equal((await page.goto(auth)).status(), 200);
  await page.getByRole('heading', { name: 'Continue to AporiaX Desktop', exact: true }).waitFor();
  await page.getByRole('textbox', { name: /Email/i }).waitFor();
  await page.waitForLoadState('networkidle');
  assert.equal(new URL(page.url()).searchParams.get('state'), pkce.state);
  assert.equal(new URL(page.url()).searchParams.get('code_challenge'), pkce.codeChallenge);
  assert(!requests.some(url => url.hostname === '101.43.44.160' || url.hostname.includes('tail0f652a') || url.hostname.includes('webapps.tcloudbase')));
  assert(!requests.some(url => url.pathname.endsWith('/v1/chat/completions')));
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
  await mkdir('.tmp/qa', { recursive: true });
  await page.screenshot({ path: '.tmp/qa/cloud-domain-authorize.png', fullPage: true });
  console.log('PASS real browser: home, anonymous account login and Desktop authorization stay on aporiax.cloud, retain PKCE parameters, no page/CSP errors. Authenticated production sign-in not exercised.');
} finally { await browser.close(); }

import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';

// Run the actual unpacked release without installing it or using a real profile.
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const output = resolve(process.argv[2] || `release/v${version}`);
const evidence = resolve('.tmp', `packaged-local-${version}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(evidence, 'profile-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
for (const key of Object.keys(env)) if (/^(?:APORIAX_|PORTABLE_|OPENAI_|CODEX_)/.test(key) ||
  ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DEEPSEEK_API_KEY'].includes(key)) delete env[key];
let application;
try {
  application = await _electron.launch({ executablePath: join(output, 'win-unpacked', 'AporiaX.exe'),
    args: [`--user-data-dir=${profile}`], env, timeout: 45000 });
  const info = await application.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, profile: app.getPath('userData') }));
  assert.equal(info.version, version); assert.equal(info.packaged, true);
  assert.equal(resolve(info.profile), profile, 'Do not inspect or change an existing user profile');
  const page = await application.firstWindow();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.desktop?.personalChatGPT), { timeout: 30000 });
  const personal = await page.evaluate(() => window.desktop.personalChatGPT.status());
  assert.equal(personal.available, false, 'The personal ChatGPT/Codex experiment remains local-development-only');
  const rejected = await page.evaluate(async () => {
    try { await window.desktop.personalChatGPT.startLogin(); return false; }
    catch (error) { return /仅在本地开发版|LOCAL_ONLY/.test(error.message); }
  });
  assert(rejected, 'Packaged builds must reject personal account login before opening a browser');
  const providers = await page.evaluate(() => window.desktop.providers.list());
  assert(!providers.some(provider => provider.id === 'chatgpt-personal'));
  await page.screenshot({ path: join(evidence, 'startup.png') });
  assert.deepEqual(errors, []);
  console.log(`PASS actual packaged ${version}: isolated profile, renderer/IPC startup, personal experiment disabled, zero page errors.`);
} finally {
  await application?.close();
  assert.equal(dirname(profile), evidence, 'Only remove the freshly-created smoke-test profile');
  await rm(profile, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createSkillRegistry } from '../electron/harness/skills/registry.js';
import { searchSkills, readSkillResource } from '../electron/skill-resources.js';
import { prepareSkillRequest, skillExecutionRoot } from '../electron/skill-runtime.js';
import { loadExtensionCatalog } from '../electron/extension-library.js';
import { builtinSkillMetadata, isBuiltinResource } from '../electron/community/builtins.js';
import { exportLocalResource, localResourceCatalog } from '../electron/community/local-repository.js';

const root = await mkdtemp(join(tmpdir(), 'aporiax-b50-builtin-'));
try {
  const registry = createSkillRegistry(), catalog = await registry.catalog();
  const skill = catalog.find(item => item.name === 'maimai-b50-roast');
  assert(skill); assert.equal(skill.title, 'qq号锐评b50'); assert.equal(skill.source, 'builtin');
  assert.equal(skill.auto, false); assert.equal(skill.metadata.runtime, 'node');
  assert(skill.instructions.includes('--no-table')); assert(skill.instructions.includes('不可绕过'));
  assert.equal(registry.activate('你好，帮我删除一个文件', { catalog }).skills.some(item => item.name === skill.name), false);
  const discovered = await searchSkills({}, { query: 'qq号锐评b50' });
  assert(discovered.skills.some(item => item.name === skill.name && item.title === 'qq号锐评b50'));
  const request = await prepareSkillRequest({ workspacePath: root, messages: [{ id: 'request', role: 'user', content: '@skill:maimai-b50-roast 按 QQ 123456789 锐评 b50' }] }, { registry });
  assert.equal(request.activatedSkills[0].title, 'qq号锐评b50');
  assert.match(request.messages[0].aporiaSkillContext, /Node script root:/);
  assert.match(request.messages[0].aporiaSkillContext, /do not grant additional permissions/i);
  assert.equal(skillExecutionRoot({ ...skill, packageRoot: 'C:\\Program Files\\AporiaX\\resources\\app.asar\\electron\\library\\curated\\maimai-b50-roast' }), 'C:\\Program Files\\AporiaX\\resources\\app.asar.unpacked\\electron\\library\\curated\\maimai-b50-roast');
  assert.equal(skillExecutionRoot({ ...skill, packageRoot: '/Applications/AporiaX.app/Contents/Resources/app.asar/electron/library/curated/maimai-b50-roast' }), '/Applications/AporiaX.app/Contents/Resources/app.asar.unpacked/electron/library/curated/maimai-b50-roast');
  assert.equal(skillExecutionRoot({ ...skill, source: 'user', packageRoot: 'C:/user/app.asar/custom' }), 'C:/user/app.asar/custom');
  for (const path of ['SKILL.md', 'reference.md', 'scripts/fetch-b50.mjs']) {
    const value = await readSkillResource({}, { skill: skill.name, path }); assert(value.content.length > 100);
  }
  await assert.rejects(readSkillResource({}, { skill: skill.name, path: '../private' }), /escapes/);
  const extension = (await loadExtensionCatalog()).entries.find(item => item.name === skill.name);
  assert.equal(extension.title, 'qq号锐评b50'); assert.equal(extension.trust, 'bundled');
  assert((await builtinSkillMetadata()).some(item => item.id === 'skill:' + skill.name && !item.uploadable));
  assert.equal(isBuiltinResource('skill', skill.name), true);
  assert((await localResourceCatalog(root)).some(item => item.id === 'skill:' + skill.name && item.builtin && !item.uploadable));
  await assert.rejects(exportLocalResource(root, 'skill:' + skill.name), /BUILTIN_RESOURCE/);
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert(pkg.build.files.includes('electron/**/*'));
  assert(pkg.build.asarUnpack.includes('electron/library/curated/maimai-b50-roast/**/*'));
  const script = join(skill.packageRoot, 'scripts', 'fetch-b50.mjs');
  assert.match(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }), /--qq/);
  const row = index => ({ title: 'Fixture ' + index, ds: 14.9, achievements: 100.8, ra: Math.floor(14.9 * 22.4 * 100.5 / 100), fc: 'fcp', fs: 'sync', level_index: 3, level_label: 'MASTER' });
  const data = { nickname: 'Offline fixture', username: 'fixture', charts: { sd: Array.from({ length: 35 }, (_, i) => row(i)), dx: Array.from({ length: 15 }, (_, i) => row(i + 35)) } };
  data.rating = [...data.charts.sd, ...data.charts.dx].reduce((sum, item) => sum + item.ra, 0);
  // Child process mocks fetch before importing the CLI. No live QQ data, model
  // calls, API credentials or external requests are used by this test.
  const run = (status, body) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.argv = ['node', 'fixture', '--qq', '123456789', '--md', '--no-table', '--top', '2'];
    globalThis.fetch = async (url, options) => {
      if (url !== 'https://www.diving-fish.com/api/maimaidxprober/query/player' || options.method !== 'POST' || JSON.parse(options.body).qq !== '123456789') throw new Error('Unexpected request blocked');
      return new Response(${JSON.stringify(typeof body === 'string' ? body : JSON.stringify(body))}, { status: ${status} });
    };
    await import(${JSON.stringify(pathToFileURL(script).href)});
  `], { encoding: 'utf8', timeout: 10000 });
  const good = run(200, data); assert.equal(good.status, 0, good.stderr); assert.match(good.stdout, /\| FC\+ \| 35 \| 15 \| 50 \|/); assert.match(good.stdout, /旧曲 35 首 \+ 新曲 15 首 = 50 首/);
  const missing = run(400, { message: 'user not exists' }); assert.equal(missing.status, 2); assert.match(missing.stderr, /确认/);
  const privateResult = run(403, { message: 'forbidden' }); assert.equal(privateResult.status, 2); assert.match(privateResult.stderr, /不可绕过/);
  const invalid = run(200, '<html>error</html>'); assert.equal(invalid.status, 2); assert.match(invalid.stderr, /非 JSON/);
  const mismatch = run(200, { ...data, rating: data.rating + 1 }); assert.equal(mismatch.status, 3); assert.match(mismatch.stderr, /禁止补齐/);
  console.log('PASS built-in qq号锐评b50: default catalog/discovery, explicit-only activation, readable package, physical ASAR script root, library title, community upload protection, package inclusion and offline CLI success/400/403/non-JSON/mismatch. No live requests.');
} finally { await rm(root, { recursive: true, force: true }); }

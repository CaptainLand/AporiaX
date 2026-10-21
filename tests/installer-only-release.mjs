import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { PUBLIC_WINDOWS_TARGETS, windowsReleaseArtifacts } from '../scripts/windows-release-artifacts.mjs';

const version = '1.0.6';
const plan = windowsReleaseArtifacts(version);
const expected = ['AporiaX-Setup-1.0.6-x64.exe', 'AporiaX-Setup-1.0.6-x64.exe.blockmap', 'latest.yml', 'SHA256SUMS-1.0.6.txt'];
assert.deepEqual(PUBLIC_WINDOWS_TARGETS, ['nsis']);
assert.deepEqual(plan.assets, expected);
assert.deepEqual(plan.payloadKinds, ['Setup']);
assert.equal(plan.checksumFiles.length, 3);
const legacy = windowsReleaseArtifacts(version, { includePortable: true });
assert.deepEqual(legacy.payloadKinds, ['Setup', 'Portable']);
assert.equal(legacy.assets.length, 5);
assert.deepEqual(windowsReleaseArtifacts(version).assets, expected, 'Legacy opt-in must not mutate the public default');
const preview = windowsReleaseArtifacts('1.0.6-preview.1', { updateFile: 'preview.yml' });
assert.ok(preview.checksumFiles.includes('preview.yml') && preview.checksumFiles.includes('latest.yml'));
assert.ok(!preview.assets.some(name => name.includes('Portable')));
for (const invalid of ['../1.0.6', '1.0.6; echo unsafe', 'v1.0.6']) assert.throws(() => windowsReleaseArtifacts(invalid));
assert.throws(() => windowsReleaseArtifacts(version, { updateFile: '../latest.yml' }));

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.deepEqual(pkg.build.win.target, [{ target: 'nsis', arch: ['x64'] }]);
const builder = await readFile('scripts/build-public-release.mjs', 'utf8');
assert.ok(builder.includes('createTarget([...PUBLIC_WINDOWS_TARGETS], Arch.x64)'));
assert.ok(!builder.includes('"portable"'));
const releaseWorkflow = await readFile('.github/workflows/release-windows.yml', 'utf8');
assert.ok(!releaseWorkflow.includes('AporiaX-Portable-'));
assert.ok(releaseWorkflow.includes('AporiaX-Setup-$version-x64.exe.blockmap'));
const mirrorWorkflow = yaml.load(await readFile('.github/workflows/upload-verified-desktop-mirror.yml', 'utf8'));
const upload = mirrorWorkflow.jobs.upload.steps.find(step => step.name === 'Download exact published mirror files and fill draft assets').run;
assert.ok(!upload.includes('AporiaX-Portable-'));
assert.ok(!upload.includes('--clobber'));
const gates = [...upload.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/g)].map(match => match[1]);
assert.equal(gates.length, 2, 'Validate both embedded manifest and draft-asset gates');

const dir = await mkdtemp(join(tmpdir(), 'aporia-installer-only-'));
const runGate = (index, pass) => {
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    cwd: dir, input: gates[index], encoding: 'utf8', windowsHide: true,
    env: { ...process.env, RELEASE_VERSION: version, RELEASE_TAG: 'v' + version },
  });
  assert.ifError(result.error);
  if (pass) assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0, 'Invalid release fixture passed the upload gate');
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const rows = plan.checksumFiles.map(name => 'a'.repeat(64) + '  ' + name);
  for (const [lines, pass] of [
    [rows, true],
    [[...rows, 'a'.repeat(64) + '  AporiaX-Portable-1.0.6-x64.exe'], false],
    [[rows[0], rows[0], rows[2]], false],
    [[rows[0], rows[1]], false],
    [[rows[0], rows[1], 'a'.repeat(64) + '  ../latest.yml'], false],
    [[rows[0], rows[1], 'not-a-hash  latest.yml'], false],
  ]) {
    await writeFile(join(dir, plan.checksumName), lines.join('\n') + '\n');
    runGate(0, pass);
  }
  const assets = [];
  for (const name of expected) {
    const bytes = Buffer.from('Fixture: ' + name);
    await writeFile(join(dir, name), bytes);
    assets.push({ name, state: 'uploaded', size: bytes.length, digest: 'sha256:' + sha(bytes) });
  }
  const draft = { tagName: 'v' + version, isDraft: true, assets };
  const checkDraft = async (release, pass) => {
    await writeFile(join(dir, 'release.json'), JSON.stringify(release));
    runGate(1, pass);
  };
  await checkDraft(draft, true);
  assert.equal(await readFile(join(dir, 'missing.txt'), 'utf8'), '');
  await checkDraft({ ...draft, assets: [assets[0]] }, true);
  assert.deepEqual((await readFile(join(dir, 'missing.txt'), 'utf8')).split('\n'), expected.slice(1));
  await checkDraft({ ...draft, assets: [] }, true);
  await checkDraft({ ...draft, isDraft: false }, false);
  await checkDraft({ ...draft, tagName: 'v1.0.5' }, false);
  await checkDraft({ ...draft, assets: [...assets, { name: 'AporiaX-Portable-1.0.6-x64.exe' }] }, false);
  await checkDraft({ ...draft, assets: [...assets, assets[0]] }, false);
  await checkDraft({ ...draft, assets: [{ ...assets[0], digest: 'sha256:' + '0'.repeat(64) }] }, false);
  await checkDraft({ ...draft, assets: [{ ...assets[0], size: 0 }] }, false);
  await checkDraft({ ...draft, assets: [{ ...assets[0], state: 'starter' }] }, false);
  console.log('Release: installer-only targets/assets, explicit legacy compatibility, exact checksum allowlist, immutable draft uploads: PASS');
} finally {
  assert.equal(dirname(dir), resolve(tmpdir()), 'Only remove the owned temporary fixture directory');
  await rm(dir, { recursive: true, force: true });
}

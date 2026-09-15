import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { verifyReleaseSource } from '../scripts/verify-release-source.mjs';
const dir = await mkdtemp(join(tmpdir(), 'aporia-release-source-'));
const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', windowsHide: true });
try {
  git('init', '-q'); await mkdir(join(dir, 'docs'));
  await writeFile(join(dir, 'package.json'), '{"version":"1.0.0"}');
  await writeFile(join(dir, 'docs/RELEASE_NOTES_v1.0.0.md'), 'Fixture release');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  git('tag', 'v1.0.0'); assert.equal(verifyReleaseSource('v1.0.0', dir).version, '1.0.0');
  assert.throws(() => verifyReleaseSource('v1.0.1', dir), /mismatch/);
  assert.throws(() => verifyReleaseSource('v1.0.0; echo unsafe', dir), /explicit version/);
  await writeFile(join(dir, 'package.json'), '{"version":"1.0.0","changed":true}');
  assert.throws(() => verifyReleaseSource('v1.0.0', dir), /clean/);
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'different HEAD');
  assert.throws(() => verifyReleaseSource('v1.0.0', dir), /HEAD/);
  const workflow = await readFile('.github/workflows/release-windows.yml', 'utf8');
  assert.ok(workflow.includes('ref: refs/tags/${{ inputs.tag }}'));
  assert.ok(workflow.indexOf('node scripts/verify-windows-release.mjs release') < workflow.indexOf('gh release upload'));
  assert.ok(!workflow.includes('--clobber'));
  assert.ok(!workflow.includes('$tag = "${{ inputs.tag }}"'));
  console.log('Release: tag/version/HEAD/dirty source, safe input transport, package-verification gate, no silent overwrite: PASS');
} finally { await rm(dir, { recursive: true, force: true }); }

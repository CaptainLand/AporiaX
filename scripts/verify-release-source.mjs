import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyReleaseSource(tag, cwd = process.cwd()) {
  assert.match(tag || '', /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'An explicit version tag is required');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
  assert.equal(tag, `v${pkg.version}`, 'Release tag/package version mismatch');
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', `refs/tags/${tag}^{commit}`), 'HEAD is not the release tag commit');
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Tracked source must be clean before building');
  assert.ok(existsSync(resolve(cwd, `docs/RELEASE_NOTES_${tag}.md`)), 'Version-specific release notes are required');
  return { tag, version: pkg.version, commit: git('rev-parse', 'HEAD') };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(verifyReleaseSource(process.env.RELEASE_TAG || process.argv[2])));
}

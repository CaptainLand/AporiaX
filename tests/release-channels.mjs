import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { synchronizeReleaseChannels } from '../scripts/release-channels.mjs';
const directory = await mkdtemp(join(tmpdir(), 'aporia-channel-'));
const write = (name, version) => writeFile(join(directory, name), `version: ${version}\npath: package-${version}.exe\n`);
try {
  for (const fresh of ['latest.yml', 'preview.yml']) {
    await write('latest.yml', '1.0.0-preview.5'); await write('preview.yml', '1.0.0-preview.5');
    await write(fresh, '1.0.0-preview.6');
    await synchronizeReleaseChannels(directory, '1.0.0-preview.6');
    assert.equal(await readFile(join(directory, 'latest.yml'), 'utf8'), await readFile(join(directory, 'preview.yml'), 'utf8'));
    assert.match(await readFile(join(directory, 'latest.yml'), 'utf8'), /preview\.6/);
  }
  await assert.rejects(synchronizeReleaseChannels(directory, '1.0.0-preview.7'), /No update metadata matches/);
  await write('rc.yml', '1.0.0-rc.1');
  await synchronizeReleaseChannels(directory, '1.0.0-rc.1');
  assert.equal(await readFile(join(directory, 'latest.yml'), 'utf8'), await readFile(join(directory, 'rc.yml'), 'utf8'));
  assert.match(await readFile(join(directory, 'latest.yml'), 'utf8'), /1\.0\.0-rc\.1/);
  await assert.rejects(synchronizeReleaseChannels(directory, '1.0.0-rc.2'), /No update metadata matches/);
  console.log('PASS release channels: either generated channel wins over stale files; unmatched version is rejected');
} finally { await rm(directory, { recursive: true, force: true }); }

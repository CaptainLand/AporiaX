import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPath7za } from 'app-builder-lib/out/toolsets/7zip.js';
import { windowsReleaseArtifacts } from './windows-release-artifacts.mjs';

// Compare the actual downloadable artifacts, not just the staging directory.
// No installer is executed and no production registry/profile is accessed.
export async function verifyWindowsPayloads(output, version, { includePortable = false } = {}) {
  const expected = join(resolve(output), 'win-unpacked');
  const scratch = await mkdtemp(join(tmpdir(), 'aporiax-payload-qa-'));
  const sevenZip = await getPath7za();
  const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  async function files(directory) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...await files(path));
      else if (entry.isFile()) found.push(path);
      else throw new Error('Unexpected payload link: ' + path);
    }
    return found;
  }
  const hashes = new Map();
  for (const file of await files(expected)) hashes.set(relative(expected, file), { size: (await stat(file)).size, hash: await digest(file) });
  const directories = {};
  for (const kind of windowsReleaseArtifacts(version, { includePortable }).payloadKinds) {
    const target = join(scratch, kind);
    execFileSync(sevenZip, ['x', join(resolve(output), `AporiaX-${kind}-${version}-x64.exe`), '-o' + target, '-y', '-bso0', '-bsp0'], { windowsHide: true, timeout: 120000 });
    const extracted = await files(target);
    assert.equal(extracted.length, hashes.size, kind + ' payload file count differs from staging');
    for (const [name, wanted] of hashes) {
      const actual = join(target, name);
      assert.equal((await stat(actual)).size, wanted.size, kind + ' payload truncated: ' + name);
      assert.equal(await digest(actual), wanted.hash, kind + ' payload corrupt/stale: ' + name);
    }
    directories[kind] = target;
    console.log(`PASS actual ${kind} payload: ${hashes.size} files byte-identical; ${target}`);
  }
  return directories;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  await verifyWindowsPayloads(process.argv[2] || `release/v${version}`, version, { includePortable: process.argv.includes('--include-portable') });
}

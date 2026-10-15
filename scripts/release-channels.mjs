import { readFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';

// Build directories can retain old channel files. Never promote stale metadata.
export async function synchronizeReleaseChannels(output, version) {
  const channel = version.includes('-') ? version.split('-')[1].split('.')[0] : 'latest';
  const names = [...new Set([channel + '.yml', 'latest.yml'])];
  const matches = [];
  for (const name of names) {
    try {
      if (yaml.load(await readFile(join(output, name), 'utf8'))?.version === version) matches.push(name);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!matches.length) throw new Error(`No update metadata matches ${version}`);
  for (const name of names) if (name !== matches[0]) await copyFile(join(output, matches[0]), join(output, name));
}

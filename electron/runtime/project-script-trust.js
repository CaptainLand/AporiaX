import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const inside = (root, file) => { const rel = relative(root, file); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')); };
// A scoped authorization fingerprint, NOT static analysis or a sandbox.
// Only simple npm-family scripts can reuse trust; arbitrary/composed commands cannot.
export async function projectScriptFingerprint(workspaceRoot, input) {
  if (!workspaceRoot || !/^\s*(?:npm|pnpm|yarn|bun)\s+(?:test|start|dev|build|run\s+[\w:.-]+)\s*$/.test(input.command || '')) return null;
  const root = await realpath(workspaceRoot);
  let directory = await realpath(resolve(root, input.cwd || '.'));
  if (!inside(root, directory)) return null;
  while (true) {
    try { await stat(resolve(directory, 'package.json')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (directory === root) return null;
    directory = dirname(directory);
  }
  const hash = createHash('sha256').update(directory);
  const visited = new Set(); let bytes = 0;
  async function add(file) {
    const actual = await realpath(file);
    if (!inside(root, actual)) throw new Error('SCRIPT_TRUST_OUTSIDE_WORKSPACE');
    if (visited.has(actual)) return;
    visited.add(actual);
    if (visited.size > 2000) throw new Error('SCRIPT_TRUST_TOO_LARGE');
    const info = await stat(actual);
    if (info.isDirectory()) {
      for (const name of (await readdir(actual)).sort()) await add(resolve(actual, name));
      return;
    }
    bytes += info.size;
    if (bytes > 20_000_000) throw new Error('SCRIPT_TRUST_TOO_LARGE');
    hash.update(relative(root, actual)).update(await readFile(actual));
  }
  const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  // Hash scripts + lockfiles + root tool configuration, and referenced local script trees.
  for (const name of (await readdir(directory)).sort()) {
    if (/^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc.*|.*config\.(?:js|cjs|mjs|ts|json)|scripts)$/.test(name)) await add(resolve(directory, name));
  }
  for (const script of Object.values(pkg.scripts || {})) {
    for (const match of String(script).matchAll(/(?:^|[\s"'])([\w./\\-]+\.(?:js|cjs|mjs|ts|sh|ps1|py))(?=$|[\s"'])/g)) {
      try { await add(resolve(directory, match[1])); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return { fingerprint: hash.digest('hex'), directory };
}

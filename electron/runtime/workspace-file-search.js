import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ripgrepExecutable, TREE_IGNORES, verifyExistingTarget, isPathInside, pathMatchesGlobs } from './workspace-runtime.js';
import { withSearchSession } from './search-session.js';

const IGNORES = new Set([...TREE_IGNORES, '.tmp', '.cache', '.aporiax', '.gradle', 'release', 'build']);
const MAX_INDEX_FILES = 100_000;
const CACHE_TTL_MS = 10_000;
const cache = new Map();

export function clearWorkspaceFileCache(root) {
  for (const [key, entry] of cache) if (!root || key === resolve(root)) {
    entry.watcher?.close(); entry.pending?.controller.abort(); cache.delete(key);
  }
}

async function scanFiles(root, session, authorizePath) {
  const files = [];
  let complete = true, engine = 'ripgrep', fallbackReason;
  if (!authorizePath) {
    try {
      await new Promise((done, fail) => {
        session.check();
        const args = ['--files', '--null', '--hidden'];
        for (const name of IGNORES) args.push('--glob', `!**/${name}/**`);
        args.push('--', '.');
        const child = spawn(ripgrepExecutable, args, { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        const decoder = new StringDecoder('utf8');
        let buffer = '', stderr = '', settled = false;
        const finish = (callback, value) => { if (settled) return; settled = true; session.signal.removeEventListener('abort', abort); callback(value); };
        const abort = () => { child.kill(); finish(fail, session.signal.reason); };
        session.signal.addEventListener('abort', abort, { once: true });
        if (session.signal.aborted) return abort();
        child.stdout.on('data', chunk => {
          buffer += decoder.write(chunk);
          const paths = buffer.split('\0'); buffer = paths.pop();
          for (const value of paths) {
            if (files.length >= MAX_INDEX_FILES) { complete = false; child.kill(); break; }
            const absolute = resolve(root, value);
            if (isPathInside(root, absolute)) files.push(relative(root, absolute).replaceAll('\\', '/'));
          }
          session.report({ engine, indexedFiles: files.length, phase: 'index' });
        });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
        child.once('error', error => finish(fail, error));
        child.once('close', code => {
          if (complete && code !== 0 && code !== 1) finish(fail, new Error(stderr || `ripgrep exited ${code}`));
          else finish(done);
        });
      });
      return { files, complete, engine };
    } catch (error) {
      session.check();
      files.length = 0;
      fallbackReason = error.code || 'RIPGREP_UNAVAILABLE';
    }
  }
  engine = 'node-fallback';
  session.report({ engine, indexedFiles: 0, phase: 'index' }, true);
  const queue = [root];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    session.check();
    const directory = queue[cursor];
    if (authorizePath) {
      try { await authorizePath(directory); } catch (error) { if (error.code === 'FILE_ACCESS_DENIED') continue; throw error; }
    }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (directory === root) throw error; complete = false; continue; }
    for (const entry of entries) {
      session.check();
      if (IGNORES.has(entry.name) || entry.isSymbolicLink()) continue;
      const absolute = resolve(directory, entry.name);
      if (!isPathInside(root, absolute)) continue;
      if (authorizePath) {
        try { await authorizePath(absolute); } catch (error) { if (error.code === 'FILE_ACCESS_DENIED') continue; throw error; }
      }
      if (entry.isDirectory()) queue.push(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute).replaceAll('\\', '/'));
      if (files.length >= MAX_INDEX_FILES) return { files, complete: false, engine, fallbackReason };
    }
    session.report({ engine, indexedFiles: files.length, phase: 'index' });
  }
  return { files, complete, engine, fallbackReason };
}

function cacheEntry(root) {
  let entry = cache.get(root);
  if (entry) { cache.delete(root); cache.set(root, entry); return entry; }
  entry = { generation: 0, builtGeneration: -1, builtAt: 0, index: null, pending: null, watcher: null };
  cache.set(root, entry);
  try {
    entry.watcher = watch(root, { recursive: true, persistent: false }, (event, name) => {
      const path = String(name || '').replaceAll('\\', '/');
      if (path.split('/').some(part => IGNORES.has(part))) return;
      if (event === 'rename' || /(?:^|\/)(?:\.gitignore|\.ignore|\.rgignore)$/.test(path)) entry.generation++;
    });
    entry.watcher.on('error', () => { entry.generation++; entry.watcher?.close(); entry.watcher = null; });
  } catch { /* The short TTL also refreshes indexes on platforms without recursive watching. */ }
  for (const [key, candidate] of cache) {
    if (cache.size <= 4) break;
    if (key !== root && !candidate.pending) clearWorkspaceFileCache(key);
  }
  return entry;
}

async function fileIndex(root, session, { refresh, authorizePath }) {
  if (authorizePath) return { ...await scanFiles(root, session, authorizePath), cached: false };
  const entry = cacheEntry(root);
  if (!refresh && entry.index && entry.builtGeneration === entry.generation && Date.now() - entry.builtAt < CACHE_TTL_MS) {
    return { ...entry.index, cached: true };
  }
  if (entry.pending?.controller.signal.aborted) entry.pending = null;
  if (!entry.pending) {
    const generation = entry.generation, controller = new AbortController(), listeners = new Set();
    const pending = { controller, listeners, promise: null };
    entry.pending = pending;
    pending.promise = withSearchSession({ signal: controller.signal, onProgress: value => {
      for (const listener of listeners) listener(value);
    } }, scan => scanFiles(root, scan)).then(index => {
      if (!controller.signal.aborted) { entry.index = index; entry.builtAt = Date.now(); entry.builtGeneration = generation; }
      return index;
    }).finally(() => { if (entry.pending === pending) entry.pending = null; });
    pending.promise.catch(() => {});
  }
  const pending = entry.pending;
  const listener = value => session.report(value);
  pending.listeners.add(listener);
  let removeAbort;
  try {
    const aborted = new Promise((_, reject) => {
      removeAbort = () => reject(session.signal.reason);
      session.signal.addEventListener('abort', removeAbort, { once: true });
      if (session.signal.aborted) removeAbort();
    });
    return { ...await Promise.race([pending.promise, aborted]), cached: false };
  } finally {
    session.signal.removeEventListener('abort', removeAbort);
    pending.listeners.delete(listener);
    if (!pending.listeners.size && entry.pending === pending) pending.controller.abort();
  }
}

export async function findWorkspaceFiles({ workspaceRoot, requestedPath = '.', query = '', includeGlobs = [], excludeGlobs = [],
  maxResults = 80, includeDirectories = false, refresh = false, authorizePath = null, signal, timeoutMs, onProgress } = {}) {
  return withSearchSession({ signal, timeoutMs, onProgress }, async session => {
    const root = await verifyExistingTarget(workspaceRoot, requestedPath);
    if (!(await lstat(root)).isDirectory()) throw new Error('The search path must be a directory.');
    const needle = String(query).trim().replaceAll('\\', '/').toLowerCase();
    if (needle.length > 500 || needle.includes('\0')) throw new Error('Invalid file search query.');
    const index = await fileIndex(root, session, { refresh, authorizePath });
    session.check();
    const candidates = index.files.map(path => ({ path, type: 'file' }));
    if (includeDirectories) {
      const directories = new Set();
      for (const path of index.files) {
        const parts = path.split('/'); parts.pop();
        while (parts.length) { directories.add(parts.join('/')); parts.pop(); }
      }
      candidates.push(...[...directories].map(path => ({ path, type: 'directory' })));
    }
    const matches = [];
    for (const candidate of candidates) {
      session.check();
      const path = candidate.path.toLowerCase(), name = basename(path);
      if (!needle.split(/\s+/).every(token => path.includes(token)) || !pathMatchesGlobs(candidate.path, includeGlobs, excludeGlobs)) continue;
      const score = name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : 3;
      matches.push({ ...candidate, score });
    }
    matches.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
    const limit = Math.min(1000, Math.max(1, Number(maxResults) || 80));
    const results = matches.slice(0, limit).map(({ path, type }) => ({
      path: relative(workspaceRoot, resolve(root, path)).replaceAll('\\', '/'), name: basename(path), type,
    }));
    session.report({ engine: index.engine, phase: 'complete', indexedFiles: index.files.length, matches: results.length, cached: index.cached }, true);
    return { query, path: requestedPath, engine: index.engine, cached: index.cached, indexedFiles: index.files.length,
      complete: index.complete, results, truncated: !index.complete || matches.length > limit, fallbackReason: index.fallbackReason };
  });
}

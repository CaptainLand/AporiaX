import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { findWorkspaceFiles, clearWorkspaceFileCache } from '../electron/runtime/workspace-file-search.js';
import { searchWorkspaceText, calculateLineChanges, verifyExistingTarget, verifyWritableTarget, runGitCommand } from '../electron/runtime/workspace-runtime.js';
import { withSearchSession } from '../electron/runtime/search-session.js';
import { createNativeToolExecutor } from '../electron/runtime/native-tool-executor.js';
import { createPermissionPolicy } from '../electron/agent-core.js';
import { dispatchNativeTool } from '../electron/runtime/tool-dispatcher.js';
import { TOOL_REGISTRY } from '../electron/runtime/native-tool-catalog.js';
import { normalizeSubagentInput, assertSubagentScope } from '../electron/runtime/subagent-model.js';

const parent = resolve(tmpdir());
const root = await mkdtemp(join(parent, 'aporiax-file-search-'));
try {
  for (const name of ['src', 'src/deep', 'node_modules/pkg', 'cache', 'links']) await mkdir(join(root, name), { recursive: true });
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.gitignore'), 'cache/\n');
  for (const [path, content] of [
    ['src/Account.jsx', 'const searchNeedle = "中文内容";\n'], ['src/deep/AccountStore.js', 'export const searchNeedle = 1;\n'],
    ['src/中文 空格.js', 'const 中文 = 1;\n'], ['root.js', 'const searchNeedle = 2;\n'],
    ['node_modules/pkg/Account.js', 'ignored'], ['cache/Account.js', 'ignored'],
  ]) await writeFile(join(root, path), content);
  const search = extra => findWorkspaceFiles({ workspaceRoot: root, query: 'account', ...extra });
  const cold = await search();
  assert.equal(cold.engine, 'ripgrep');
  assert.equal(cold.cached, false);
  assert.equal(cold.complete, true);
  assert.deepEqual(cold.results.map(item => item.path), ['src/Account.jsx', 'src/deep/AccountStore.js']);
  assert.equal((await search()).cached, true, 'Repeated queries reuse the metadata-only index');
  assert.deepEqual((await search({ query: '中文' })).results.map(item => item.path), ['src/中文 空格.js']);
  assert.deepEqual((await search({ query: 'account store' })).results.map(item => item.path), ['src/deep/AccountStore.js']);
  assert.deepEqual((await search({ query: '', includeGlobs: ['**/*.{js,jsx}'], excludeGlobs: ['**/deep/**'] })).results.map(item => item.path).sort(), ['root.js', 'src/Account.jsx', 'src/中文 空格.js'].sort());
  assert.equal((await search({ maxResults: 1 })).truncated, true);
  assert.equal((await search({ query: 'store', maxResults: 1 })).truncated, false, 'An exact-size complete result is not marked partial');
  await writeFile(join(root, 'src/NewAccount.js'), '');
  // The real filesystem watcher must invalidate a cached negative result.
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise(done => setTimeout(done, 20)); }
    assert.fail(label);
  };
  await waitFor(async () => (await search({ query: 'newaccount' })).results.length === 1, 'create invalidates the index');
  await rename(join(root, 'src/NewAccount.js'), join(root, 'src/Renamed.js'));
  await waitFor(async () => !(await search({ query: 'newaccount' })).results.length && (await search({ query: 'renamed' })).results.length === 1, 'rename invalidates the index');
  await rm(join(root, 'src/Renamed.js'));
  await waitFor(async () => !(await search({ query: 'renamed' })).results.length, 'delete invalidates the index');
  await writeFile(join(root, '.gitignore'), 'cache/\nsrc/deep/\n');
  await waitFor(async () => !(await search({ query: 'store' })).results.length, 'ignore rules invalidate the index');
  assert.equal((await search({ refresh: true })).cached, false);
  clearWorkspaceFileCache();
  const shared = await Promise.all([search(), search({ query: '中文' })]);
  assert.ok(shared.every(result => result.engine === 'ripgrep' && result.complete));
  const text = await searchWorkspaceText({ workspaceRoot: root, requestedPath: '.', query: 'searchNeedle', includeGlobs: ['*.js', '*.jsx'] });
  assert.equal(text.engine, 'ripgrep');
  assert.equal(text.results.length, 2);
  assert.ok(text.results.every(result => result.line === 1));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(search({ signal: controller.signal }), { name: 'AbortError' });
  const blocked = () => new Promise(() => {});
  await assert.rejects(search({ authorizePath: blocked, timeoutMs: 20 }), { code: 'SEARCH_TIMEOUT' });
  await assert.rejects(searchWorkspaceText({ workspaceRoot: root, requestedPath: '.', query: 'x', authorizePath: blocked, timeoutMs: 20 }), { code: 'SEARCH_TIMEOUT' });
  const cancel = new AbortController();
  const pending = searchWorkspaceText({ workspaceRoot: root, requestedPath: '.', query: 'x', authorizePath: blocked, signal: cancel.signal });
  setTimeout(() => cancel.abort(), 20);
  await assert.rejects(pending, { name: 'AbortError' });
  const progress = [];
  await withSearchSession({ onProgress: value => progress.push(value), timeoutMs: 3000 }, async session => {
    session.report({ engine: 'ripgrep', matches: 3 });
    await new Promise(done => setTimeout(done, 1050));
  });
  assert.ok(progress.length >= 2 && progress.at(-1).elapsedMs >= 900, 'Slow searches report a heartbeat without inventing percentages');
  assert.ok(progress.every(value => value.matches === 3 && value.percent === undefined));
  const denied = path => {
    if (path.includes('deep')) throw Object.assign(Error('protected'), { code: 'FILE_ACCESS_DENIED' });
  };
  const guarded = await search({ query: '', authorizePath: denied });
  assert.equal(guarded.engine, 'node-fallback');
  assert.equal(guarded.cached, false);
  assert.ok(guarded.results.every(result => !result.path.includes('deep')));
  const executor = createNativeToolExecutor({ calculateLineChanges, verifyExistingTarget, verifyWritableTarget, searchWorkspaceText, runGitCommand });
  const result = await dispatchNativeTool({
    toolCall: { id: 'find-1', function: { name: 'find_files', arguments: JSON.stringify({ query: 'account', path: 'src' }) } },
    registry: TOOL_REGISTRY, permissionPolicy: createPermissionPolicy('read-only'), parseArguments: call => JSON.parse(call.function.arguments),
    executeAuthorized: executor, executeContext: { workspaceRoot: root },
  });
  assert.deepEqual(result.modelResult.results.map(item => item.path), ['src/Account.jsx']);
  assert.equal(result.change, undefined);
  const worker = normalizeSubagentInput({ role: 'explore', task: 'Find the account component', scope: ['src'] });
  assert.doesNotThrow(() => assertSubagentScope('find_files', { path: 'src' }, worker.scope));
  assert.throws(() => assertSubagentScope('find_files', { path: '.' }, worker.scope), /scope/i);
  console.log('PASS file search: native enumeration, cache/watch invalidation, Unicode/globs, limits, ignore rules, deadlines/cancellation/progress, guarded traversal and real read-only Agent dispatch.');
} finally {
  clearWorkspaceFileCache();
  const target = relative(parent, resolve(root));
  assert.ok(target.startsWith('aporiax-file-search-') && !target.includes(sep));
  await rm(root, { recursive: true, force: true });
}

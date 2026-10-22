const assert = require('node:assert/strict');
const { app } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const [archive, workspace, testRoot] = process.argv.slice(2);
app.disableHardwareAcceleration();
app.setPath('userData', join(testRoot, 'electron-profile'));
app.whenReady().then(async () => {
  const { searchWorkspaceText } = await import(pathToFileURL(join(archive, 'electron/runtime/workspace-runtime.js')).href);
  const search = async extra => {
    const result = await searchWorkspaceText({ workspaceRoot: workspace, requestedPath: '.', query: 'alpha',
      caseSensitive: false, maxResults: 20, signal: new AbortController().signal, ...extra });
    assert.equal(result.engine, 'ripgrep', 'packaged searches must not silently fall back to Node traversal');
    return result;
  };
  const literal = await search({ excludeGlobs: ['**/*.test.js'] });
  assert.deepEqual(literal.results.map(item => [item.path, item.line]), [['src/示例 file.js', 1]],
    'literal search preserves Unicode/spaces and respects .gitignore and exclusion globs');
  const regex = await search({ requestedPath: 'src', mode: 'regex', query: 'const\\s+(Alpha|beta)',
    caseSensitive: true, includeGlobs: ['*.js'], excludeGlobs: ['*.test.js'] });
  assert.deepEqual(regex.results.map(item => item.line), [1, 2]);
  const noMatches = await search({ query: 'not-present-739adc' });
  assert.deepEqual(noMatches.results, []);
  const limited = await search({ requestedPath: 'src', query: 'const', maxResults: 1 });
  assert.equal(limited.results.length, 1);
  assert.equal(limited.truncated, true);
  const { findWorkspaceFiles, clearWorkspaceFileCache } = await import(pathToFileURL(join(archive, 'electron/runtime/workspace-file-search.js')).href);
  const files = await findWorkspaceFiles({ workspaceRoot: workspace, query: '示例' });
  assert.equal(files.engine, 'ripgrep');
  assert.deepEqual(files.results.map(entry => entry.path), ['src/示例 file.js']);
  clearWorkspaceFileCache();
  console.log('PASS packaged workspace search: real ASAR/unpacked executable, Unicode/spaces, literal/regex, ignores, empty results and result limit.');
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });

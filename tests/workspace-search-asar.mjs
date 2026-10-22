import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { createPackageWithOptions, statFile } from '@electron/asar';
import electron from 'electron';
import minimatch from 'minimatch';

// Exercise the same ASAR layout and actual executable used by the installer.
// No released installation or existing release artifact is modified.
const parent = resolve(tmpdir());
const root = await mkdtemp(join(parent, 'aporiax search 路径-'));
try {
  const source = join(root, 'source');
  const archive = join(root, 'app.asar');
  const workspace = join(root, 'workspace');
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  await mkdir(source);
  await writeFile(join(source, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const file of [
    'electron/runtime/workspace-runtime.js', 'electron/link-target.js',
    'electron/control/policy.js', 'electron/runtime/file-access-policy.js',
    'electron/runtime/workspace-patch.js',
    'electron/runtime/search-session.js', 'electron/runtime/workspace-file-search.js',
  ]) {
    await mkdir(dirname(join(source, file)), { recursive: true });
    await cp(resolve(file), join(source, file));
  }
  const platformPackage = `@vscode/ripgrep-${process.platform}-${process.arch}`;
  for (const name of ['@vscode/ripgrep', platformPackage, 'diff']) {
    await cp(resolve('node_modules', name), join(source, 'node_modules', name), { recursive: true });
  }
  const binary = normalize(`node_modules/${platformPackage}/bin/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`);
  assert.ok(pkg.build.asarUnpack.some(pattern => minimatch(binary.replaceAll('\\', '/'), pattern)),
    'electron-builder must unpack the platform search executable');
  // Reproduce that release layout; @electron/asar uses native directory prefixes.
  await createPackageWithOptions(source, archive, { unpackDir: join('node_modules', platformPackage) });
  assert.equal(statFile(archive, binary).unpacked, true, 'release rules must unpack the search executable');
  assert.notEqual(statFile(archive, normalize('electron/runtime/workspace-runtime.js')).unpacked, true,
    'the tested runtime must load from inside ASAR');

  await mkdir(join(workspace, '.git'), { recursive: true });
  await mkdir(join(workspace, 'src'));
  await mkdir(join(workspace, 'cache'));
  await writeFile(join(workspace, '.gitignore'), 'cache/\n');
  await writeFile(join(workspace, 'src', '示例 file.js'), 'const Alpha = 1;\nconst beta = 2;\n');
  await writeFile(join(workspace, 'src', 'skip.test.js'), 'const Alpha = 3;\n');
  await writeFile(join(workspace, 'cache', 'ignored.js'), 'const Alpha = 4;\n');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done, fail) => {
    const child = spawn(electron, [resolve('tests/workspace-search-asar-electron.cjs'), archive, workspace, root],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const timer = setTimeout(() => { child.kill(); }, 30_000);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return fail(new Error(`Packaged search exited ${code}:\n${output}`));
      assert.match(output, /PASS packaged workspace search/);
      console.log(output.trim());
      done();
    });
  });
} finally {
  // Electron releases its ASAR handle on exit; clean only this generated fixture.
  const within = relative(parent, resolve(root));
  assert.ok(within.startsWith('aporiax search 路径-') && !within.includes(sep));
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

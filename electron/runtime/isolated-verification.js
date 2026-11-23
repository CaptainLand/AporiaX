import { mkdtemp, mkdir, readdir, lstat, readFile, copyFile, rm, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { getSandboxStatus, runSandboxedCommand, createHostFallbackEnvironment } from '../sandbox-runtime.js';
import { verifyNativeFileTarget } from './file-access-policy.js';

export const VERIFY_PROJECT_TOOL = { type: 'function', function: {
  name: 'verify_project',
  description: 'Check delegated work: node_check only parses JS without execution. script runs any existing npm script with optional arguments; command supports any language/toolchain. Executable checks use the same parent-authorized command backend and approvals as run_command, not implicit Docker-only restrictions. A worktree is not OS isolation.',
  parameters: { type: 'object', properties: {
    kind: { type: 'string', enum: ['script', 'node_check', 'command'] },
    script: { type: 'string', description: 'Existing package.json script name.' },
    args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed to the selected npm script.' },
    command: { type: 'string', description: 'Check command for any installed language/toolchain; follows normal command approval.' },
    timeout_ms: { type: 'integer', minimum: 1, description: 'Optional explicit deadline; omitted means no fixed total duration.' },
    path: { type: 'string', description: 'Workspace-relative JS/MJS/CJS file for node_check.' },
    cwd: { type: 'string', description: 'Workspace-relative package directory, default root.' },
  }, required: ['kind'], additionalProperties: false },
} };
const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'); };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const skipped = /^(?:\.git|\.aporiax|node_modules|dist|release|coverage|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.env(?:\..*)?|credentials(?:\.json)?|id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|key|p12|pfx))$/i;
async function target(root, path = '.') {
  if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path) || /^[a-z]:/i.test(path)) throw new Error('Verification paths must be workspace-relative.');
  const result = await realpath(resolve(root, path));
  if (!inside(root, result)) throw new Error('Verification path escapes the workspace.');
  await verifyNativeFileTarget(root, path, { writable: false });
  return result;
}
export async function verificationCommand(root, input) {
  if (Object.keys(input).some(key => !['kind', 'script', 'args', 'command', 'timeout_ms', 'path', 'cwd'].includes(key))) throw new Error('Unsupported verification argument.');
  const cwd = await target(root, input.cwd || '.');
  if (!(await lstat(cwd)).isDirectory()) throw new Error('Verification cwd must be a directory.');
  if (input.kind === 'node_check') {
    if (input.script || !/\.(?:mjs|cjs|js)$/i.test(input.path || '')) throw new Error('Node syntax checks require a JS/MJS/CJS file.');
    const path = await target(root, input.path);
    if (!(await lstat(path)).isFile()) throw new Error('Syntax-check target must be a file.');
    return { cwd, path, command: `node --check ${quote(input.path)}` };
  }
  if (input.kind === 'command') {
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0') || input.script || input.path || input.args) throw Error('Invalid verification command.');
    return { cwd, command: input.command.trim() };
  }
  if (input.kind !== 'script' || input.path || input.command || !/^[a-z0-9_][a-z0-9_.:-]*$/i.test(input.script || '')) throw new Error('Choose an existing npm script, or use kind=command.');
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string' || /[\0\r\n]/.test(arg)))) throw Error('Invalid verification script arguments.');
  const manifest = JSON.parse(await readFile(await target(root, relative(root, join(cwd, 'package.json'))), 'utf8'));
  if (!Object.hasOwn(manifest.scripts || {}, input.script)) throw new Error(`Verification script does not exist: ${input.script}`);
  // Names do NOT prove safety. All code runs on a disposable snapshot in a
  // no-network OS sandbox, and npm pre/post hooks are disabled.
  const shellQuote = value => process.platform === 'win32' ? (/["%!\r\n\0]/.test(value) ? (() => { throw Error('Use a checked script file for arguments containing Windows shell expansion.'); })() : `"${value}"`) : quote(value);
  return { cwd, command: `npm --ignore-scripts run ${shellQuote(input.script)}${input.args?.length ? ' -- ' + input.args.map(shellQuote).join(' ') : ''}` };
}

function parseOnly({ path, cwd, command }, signal) {
  signal?.throwIfAborted();
  return new Promise((resolveCheck, rejectCheck) => {
    const child = spawn(process.execPath, ['--check', '--', path], { cwd, shell: false, windowsHide: true,
      env: { ...createHostFallbackEnvironment(process.env), ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { child.kill(); if (!settled) { settled = true; cleanup(); rejectCheck(Object.assign(new Error('Syntax check cancelled.'), { name: 'AbortError' })); } };
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-32000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-32000); });
    child.once('error', error => { if (!settled) { settled = true; cleanup(); rejectCheck(error); } });
    child.once('close', code => { if (!settled) { settled = true; cleanup(); resolveCheck({ command, exitCode: code, stdout, stderr, timedOut,
      verification: true, parseOnly: true, isolated: false, writeback: false,
      sandbox: { backend: 'trusted-node-parser', codeExecution: false, shell: false } }); } });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export async function runIsolatedVerification({ workspaceRoot, dependencyWorkspaceRoot = workspaceRoot, input, signal,
  sandboxStatus, runner = runSandboxedCommand, statusLoader = getSandboxStatus }) {
  signal?.throwIfAborted();
  const root = await realpath(workspaceRoot), selected = await verificationCommand(root, input);
  // This is a separate parse-only operation, NEVER a fallback for scripts.
  // --check parses imports but does not execute project code or load modules.
  if (input.kind === 'node_check') return parseOnly(selected, signal);
  const status = sandboxStatus?.available ? sandboxStatus : await statusLoader();
  if (!status?.available) throw new Error('ISOLATED_VERIFICATION_UNAVAILABLE: Docker isolation is not ready; no host command was run. Ask Main/Verify for an approved check and report it as unverified.');
  const temporary = await mkdtemp(join(tmpdir(), 'aporiax-worker-check-')), snapshot = join(temporary, 'workspace');
  let files = 0, bytes = 0;
  async function copy(source, destination) {
    signal?.throwIfAborted();
    const info = await lstat(source);
    if (info.isSymbolicLink()) return;
    try { await verifyNativeFileTarget(root, relative(root, source) || '.', { writable: false }); }
    catch (error) { if (error.code === 'FILE_ACCESS_DENIED') return; throw error; }
    if (info.isDirectory()) {
      await mkdir(destination, { recursive: true });
      for (const entry of await readdir(source, { withFileTypes: true })) if (!skipped.test(entry.name)) await copy(join(source, entry.name), join(destination, entry.name));
    } else if (info.isFile()) {
      if (++files > 50000 || (bytes += info.size) > 256 * 1024 ** 2) throw new Error('Verification snapshot too large; narrow the project and report this check as unverified.');
      await copyFile(source, destination);
    }
  }
  try {
    await copy(root, snapshot);
    let dependencyRoot;
    const dependencyOwner = await realpath(dependencyWorkspaceRoot), candidate = join(dependencyOwner, 'node_modules');
    try {
      const info = await lstat(candidate);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await verifyNativeFileTarget(dependencyOwner, 'node_modules', { writable: false });
        dependencyRoot = candidate;
      }
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = await runner({ command: selected.command, workspaceRoot: snapshot,
      cwd: join(snapshot, relative(root, selected.cwd)), dependencyRoot, signal, sandboxStatus: status });
    return { ...result, command: selected.command, cwd: input.cwd || '.', verification: true, isolated: true, writeback: false, snapshot: true };
  } finally {
    // Only this exact freshly-created disposable directory, never user paths.
    await rm(temporary, { recursive: true, force: true });
  }
}

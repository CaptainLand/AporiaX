import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function createOcrProcess(path, options) {
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (/^(PATH|SystemRoot|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i.test(key)) env[key] = value;
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const host = fileURLToPath(new URL('./process-host.mjs', import.meta.url)).replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
  const child = fork(host, [], { env, execArgv: ['--max-old-space-size=256'], serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  child.once('spawn', () => { if (child.connected) child.send({ path, options }, error => { if (error) child.emit('error', error); }); });
  child.terminate = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000); timer.unref?.();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
  return child;
}

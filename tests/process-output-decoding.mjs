import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { createPersistentProcessManager } from '../electron/runtime/process-runtime.js';
import { StringDecoder } from 'node:string_decoder';

// A real subprocess writes one byte per stream per timer tick, deliberately
// separating Chinese/emoji code points across pipe chunks and stream boundaries.
const events = [];
const manager = createPersistentProcessManager({ emit: event => events.push(event) });
const out = [...Buffer.from('中🙂\n')], err = [...Buffer.from('错误\n'), 0xe4];
const script = `const a=Buffer.from([${out}]),b=Buffer.from([${err}]);let i=0;const t=setInterval(()=>{if(i<a.length)process.stdout.write(a.subarray(i,i+1));if(i<b.length)process.stderr.write(b.subarray(i,i+1));if(++i>=Math.max(a.length,b.length))clearInterval(t);},25);`;
try {
  const started = manager.start({ command: `"${process.execPath}" -e "${script}"`, cwd: process.cwd() });
  const result = await manager.wait({ processId: started.processId, until: 'exit', timeoutMs: 15_000 });
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 0);
  const text = stream => events.filter(event => event.type === 'process.output' && event.stream === stream).map(event => event.text).join('');
  assert.equal(text('stdout'), '中🙂\n');
  assert.equal(text('stderr'), '错误\n�', 'EOF must flush an incomplete code point exactly once');
  assert.ok(result.output.includes('中') && result.output.includes('🙂'));
} finally { await manager.closeAll(); }

// Exercise a pipe error/close without spawning a process or an unhandled error.
const source = (await readFile('electron/runtime/process-runtime.js', 'utf8'))
  .replace(/import[\s\S]*?from\s+"[^"]+";/g, '').replace('export function', 'function');
const child = new EventEmitter();
Object.assign(child, { pid: 100, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
const create = runInNewContext(source + '\ncreatePersistentProcessManager', {
  randomUUID: () => 'mock-decoder', spawn: () => child, join, process, StringDecoder,
  currentExecutionMode: () => 'safe', createHostFallbackEnvironment: () => ({}), setTimeout, clearTimeout,
});
const brokenEvents = [];
const broken = create({ emit: event => brokenEvents.push(event) });
const started = broken.start({ command: 'fixture', cwd: process.cwd() });
child.stdout.emit('data', Buffer.from([0xe4]));
child.stdout.emit('error', new Error('pipe failure'));
child.stdout.emit('close');
child.stderr.emit('data', Buffer.from('正常'));
child.stderr.emit('end');
child.emit('close', 1, null);
assert.equal(brokenEvents.filter(event => event.stream === 'stdout').map(event => event.text).join(''), '�');
assert.equal(brokenEvents.filter(event => event.stream === 'stderr').map(event => event.text).join(''), '正常');
assert.match(broken.read({ processId: started.processId }).output, /\[stdout-error\] pipe failure/);
assert.equal(broken.read({ processId: started.processId }).status, 'exited');
await broken.closeAll();
console.log('PASS process output: split UTF-8, independent stdout/stderr, EOF/error flush exactly once, readable pipe errors');

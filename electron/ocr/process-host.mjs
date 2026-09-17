// Native Canvas/WASM live in this child, never in Electron Main.
import { Worker } from 'node:worker_threads';
let worker;
function send(message) {
  if (process.connected) process.send(message, error => { if (error) void worker?.terminate(); });
}
process.once('message', ({ path, options }) => {
  try {
    worker = new Worker(path, options);
    worker.on('message', send);
    worker.on('error', error => { send({ type: 'error', error: error.message }); process.exitCode = 1; });
    worker.on('exit', code => { process.exitCode = code; if (process.connected) process.disconnect(); });
  } catch (error) { send({ type: 'error', error: error.message }); process.exitCode = 1; if (process.connected) process.disconnect(); }
});
process.on('disconnect', () => { Promise.resolve(worker?.terminate()).finally(() => process.exit(process.exitCode || 0)); });

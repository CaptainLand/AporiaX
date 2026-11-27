import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const source = (await readFile('electron/workbench/service.js', 'utf8'))
  .replace(/import[\s\S]*?from\s+["'][^"']+["'];/g, '')
  .replaceAll('export function', 'function').replace('createRequire(import.meta.url)', 'createRequire()');
let sequence = 0;
class Browser {
  constructor(input) {
    Object.assign(this, input, { id: `browser-${++sequence}`, kind: 'browser', closed: false,
      view: { setVisible() {} }, ready: Promise.resolve() });
  }
  changed() { this.publish(this.state()); }
  state() { return { id: this.id, kind: this.kind, owner: this.owner, closed: this.closed, present: Boolean(this.present) }; }
  claimForAgent() { this.owner = 'agent'; }
  async open() { return { ...this.state(), lifecycle: { survivesTask: true } }; }
  async screenshot() { this.present = true; return {}; }
  async takeover() { this.owner = 'user'; this.changed(); return this.state(); }
  async close() { this.closed = true; this.changed(); }
}
const processManagers = [];
function createPersistentProcessManager({ emit }) {
  const records = new Map(), killed = [];
  const api = {
    start() {
      const event = { type: 'process.started', processId: `process-${++sequence}`, status: 'running', command: 'fixture', cwd: process.cwd() };
      records.set(event.processId, event); emit(event); return event;
    },
    async kill(processId) { killed.push(processId); emit({ type: 'process.exited', processId, status: 'exited', exitCode: 0 }); },
    killed,
  };
  processManagers.push(api); return api;
}
const terminalChildren = [];
const pty = { spawn() {
  const child = { killed: false, onData() {}, onExit(callback) { this.exited = callback; },
    kill() { this.killed = true; this.exited?.({ exitCode: 0 }); } };
  terminalChildren.push(child); return child;
} };
const create = runInNewContext(source + '\ncreateWorkbenchService', {
  app: { getPath: () => tmpdir() }, dialog: {}, process, join, resolve, randomUUID: () => String(++sequence),
  createRequire: () => () => pty, WorkbenchBrowserSession: Browser, createPersistentProcessManager,
  createBrowserProfiles: () => ({ ready: Promise.resolve(), partition: () => 'fixture' }),
  createWorkbenchGitService: () => ({}), getVerifiedWorkspaceRoot: async root => root,
  interactiveTerminalEnvironment: () => ({}), wakeTerminalReaders() {}, setTimeout, clearTimeout,
});
const viewEvents = [], events = [];
const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_, event) => events.push(event) },
  contentView: { addChildView() {}, removeChildView: view => viewEvents.push(view) } };
const service = create({ getWindow: () => window });
const context = taskId => ({ taskId, workspacePath: process.cwd(), emit() {} });
const request = (ctx, input) => service.request({ ...ctx, ...input });

// Completing many tasks should not accumulate hidden test servers or browsers.
for (let i = 0; i < 15; i++) {
  const run = service.acquire(context(`temporary-${i}`));
  const process = run.processManager.start();
  const opened = await run.browserRuntime.open({ url: 'fixture' });
  assert.equal(opened.lifecycle.survivesTask, false, 'temporary browser lifecycle must not promise to survive cleanup');
  const page = [...service.resources.values()].find(resource => resource.kind === 'browser');
  await run.browserRuntime.screenshot(); // visible screenshot != delivered preview
  await run.release(); await run.release();
  assert.deepEqual(run.processManager.killed, [process.processId], 'release must be idempotent');
  assert.equal(page.closed, true);
  assert.equal(service.resources.size, 0);
}

// Worker-first navigation must not cause Main to borrow its private page.
for (const delivered of [false, true]) {
  const ctx = context(`worker-first-${delivered}`), run = service.acquire(ctx);
  const worker = await run.browserRuntime.forOwner('worker').open({ url: 'worker' });
  const main = await run.browserRuntime.open({ url: 'main' });
  assert.notEqual(main.id, worker.id, 'Main and worker use separate pages');
  assert.equal(main.lifecycle.survivesTask, false, 'a new Main page is not a borrowed user tab');
  const workerPage = service.resources.get(worker.id), mainPage = service.resources.get(main.id);
  if (delivered) run.present.browser();
  assert.equal(Boolean(workerPage.delivered), false, 'present.browser only delivers Main');
  await run.release();
  assert.equal(workerPage.closed, true);
  assert.equal(mainPage.closed, !delivered);
  if (delivered) await request(ctx, { action: 'stop', id: main.id });
  assert.equal(service.resources.size, 0);
}

// The same delivery rule applies when Main opened first and via present.live.
const liveCtx = context('main-first-live'), liveRun = service.acquire(liveCtx);
const mainPage = await liveRun.browserRuntime.open({ url: 'main' });
const privatePage = await liveRun.browserRuntime.forOwner('private').open({ url: 'private' });
const privateResource = service.resources.get(privatePage.id);
liveRun.present.live();
await liveRun.release();
assert.equal(service.resources.has(mainPage.id), true);
assert.equal(privateResource.closed, true);
assert.equal(service.resources.has(privatePage.id), false);
await request(liveCtx, { action: 'stop', id: mainPage.id });

// Explicitly delivered resources survive success, but a user keep=false wins.
const ctx = context('delivered'), run = service.acquire(ctx);
const delivered = run.processManager.start(), optedOut = run.processManager.start(), pinned = run.processManager.start();
run.present.process(delivered.processId); run.present.process(optedOut.processId);
await request(ctx, { action: 'keep', id: optedOut.processId, value: false });
assert.equal(run.present.process(optedOut.processId).survivesTask, false);
await request(ctx, { action: 'keep', id: pinned.processId, value: true });
await run.browserRuntime.open({ url: 'fixture' });
const page = [...service.resources.values()].find(resource => resource.kind === 'browser');
run.present.browser();
assert.equal((await run.browserRuntime.open({ url: 'fixture' })).lifecycle.survivesTask, true);
await run.release();
assert.deepEqual(run.processManager.killed, [optedOut.processId]);
assert.equal(service.resources.get(delivered.processId).owner, 'user');
assert.equal(service.resources.get(pinned.processId).keepAlive, true);
assert.equal(service.resources.get(optedOut.processId).keepAlive, false);
assert.equal(service.resources.get(optedOut.processId).status, 'exited', 'delivered stopped logs stay readable');
assert.equal(page.closed, false); assert.equal(page.owner, 'user');

// Abort closes delivered-but-unpinned resources, keeps explicitly pinned ones.
const abortCtx = context('aborted'), abortRun = service.acquire(abortCtx);
const abortDelivered = abortRun.processManager.start(), abortPinned = abortRun.processManager.start();
abortRun.present.process(abortDelivered.processId);
await request(abortCtx, { action: 'keep', id: abortPinned.processId, value: true });
await abortRun.browserRuntime.open({ url: 'fixture' });
const abortPage = [...service.resources.values()].find(resource => resource.taskId === abortCtx.taskId && resource.kind === 'browser');
abortRun.present.browser();
await abortRun.release({ aborted: true });
assert.deepEqual(abortRun.processManager.killed, [abortDelivered.processId]);
assert.equal(abortPage.closed, true);
assert.equal(service.resources.get(abortPinned.processId).owner, 'user');

// An existing user browser can be borrowed, never destroyed by task cleanup.
const borrowedCtx = context('borrowed');
const existing = await request(borrowedCtx, { action: 'new-browser' });
const terminal = await request(borrowedCtx, { action: 'new-terminal' });
const borrowedRun = service.acquire(borrowedCtx);
await borrowedRun.browserRuntime.open({ url: 'fixture' });
assert.equal(service.resources.get(existing.id).owner, 'agent');
await borrowedRun.release({ aborted: true });
assert.equal(service.resources.get(existing.id).closed, false);
assert.equal(service.resources.get(existing.id).owner, 'user');
assert.equal(service.resources.get(terminal.id).status, 'running');
assert.equal(terminalChildren.at(-1).killed, false);

// A user taking over a newly created page also transfers its lifetime.
const takeoverCtx = context('takeover'), takeoverRun = service.acquire(takeoverCtx);
await takeoverRun.browserRuntime.open({ url: 'fixture' });
const takeoverPage = [...service.resources.values()].find(resource => resource.taskId === takeoverCtx.taskId);
await request(takeoverCtx, { action: 'takeover', id: takeoverPage.id });
await takeoverRun.release({ aborted: true });
assert.equal(takeoverPage.closed, false);
assert.equal(takeoverPage.owner, 'user');

// Workers belong to the same visible task, but cannot adopt Main's browser.
const parentContext = context('worker-isolation'), parentRun = service.acquire(parentContext);
await parentRun.browserRuntime.open({ url: 'parent' });
const parentPage = [...service.resources.values()].find(resource => resource.taskId === parentContext.taskId && resource.kind === 'browser');
const workerRun = service.acquire({ ...parentContext, runId: 'worker-1', ownerId: 'worker-1' });
await workerRun.browserRuntime.open({ url: 'worker' });
const peers = [...service.resources.values()].filter(resource => resource.taskId === parentContext.taskId && resource.kind === 'browser');
assert.equal(peers.length, 2); await workerRun.release();
assert.equal(parentPage.closed, false, 'finishing a worker never closes the parent browser'); await parentRun.release();

// One failed cleanup must not prevent the remaining resources from closing.
const failureCtx = context('cleanup-failure'), failureRun = service.acquire(failureCtx);
const badProcess = failureRun.processManager.start(), goodProcess = failureRun.processManager.start();
const badResource = service.resources.get(badProcess.processId), closeBadResource = badResource.close;
badResource.close = async () => { throw new Error('fixture cleanup failure'); };
await assert.rejects(failureRun.release(), /Failed to release 1 task resource/);
assert.deepEqual(failureRun.processManager.killed, [goodProcess.processId]);
assert.equal(service.resources.has(goodProcess.processId), false);
assert.equal(service.resources.has(badProcess.processId), true, 'failed cleanup must remain reachable for user recovery');
badResource.close = closeBadResource;
await service.closeAll();
console.log('PASS workbench release: temporary resource cleanup, explicit delivery/pin, keep=false, abort policy, borrowed/user browser and manual terminal protection');

const { app, powerMonitor, net } = require("electron");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const delay = ms => new Promise(done => setTimeout(done, ms));
const deadline = setTimeout(() => { console.error("Packaged suspension test timed out"); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  const version = require("../package.json").version;
  const archive = resolve(process.argv[2] || 'release/v' + version + '/win-unpacked/resources/app.asar');
  const load = path => import(pathToFileURL(join(archive, path)));
  const { createHarnessTaskRuntime } = await load("electron/harness/task-runtime.js");
  const { closeRunJournalStore } = await load("electron/run-store.js");
  const { monitorTaskEnvironment } = await load("electron/runtime/environment-monitor.js");
  const { completeLoopRequest } = await load("electron/runtime/loop-recovery.js");
  assert.equal(typeof net.isOnline(), "boolean");
  const directory = await mkdtemp(join(tmpdir(), "aporiax-packaged-suspension-"));
  const runtime = createHarnessTaskRuntime({ dataDirectory: directory });
  // Synthetic events in this isolated Electron process, never OS sleep/network mutation.
  const dispose = monitorTaskEnvironment({ powerMonitor, net: { isOnline: () => true }, runtime });
  let attempts = 0, start;
  try {
    const pending = runtime.start({ runId: "packaged-suspension", metadata: { prompt: "keep context" }, execute: async ({ signal }) =>
      completeLoopRequest({ signal, conversation: [{ role: "user", content: "keep context" }], getBody: messages => ({ messages }),
        complete: async (body, requestSignal) => {
          assert.equal(body.messages[0].content, "keep context");
          if (++attempts > 1) return { message: { content: "resumed" } };
          start = true;
          return new Promise((_, reject) => requestSignal.addEventListener("abort", () =>
            reject(Object.assign(new Error("request suspended"), { name: "AbortError" })), { once: true }));
        } }).then(result => ({ status: "completed", content: result.message.content })) });
    while (!start) await delay(5);
    powerMonitor.emit("suspend"); await runtime.pause("packaged-suspension"); await delay(20);
    assert.deepEqual(runtime.getActiveRun("packaged-suspension").pauseReasons, ["sleep", "user"]);
    const saved = await runtime.recoveryContext("packaged-suspension");
    assert.equal(saved.checkpoint.agents["incomplete-response:main"].incomplete, true);
    powerMonitor.emit("resume"); await delay(30);
    assert.equal(attempts, 1); assert.deepEqual(runtime.getActiveRun("packaged-suspension").pauseReasons, ["user"]);
    await runtime.resume("packaged-suspension");
    assert.equal((await pending).content, "resumed"); assert.equal(attempts, 2);
    assert.equal(runtime.hasActiveRuns(), false);
    console.log("PASS packaged " + version + ": Electron powerMonitor wiring, paused SQLite checkpoint, manual-pause precedence, same-context resume, no OS sleep or network changes.");
  } finally { dispose(); await closeRunJournalStore(directory); await rm(directory, { recursive: true, force: true }); }
}).then(() => { clearTimeout(deadline); app.exit(0); }, error => { console.error(error); clearTimeout(deadline); app.exit(1); });

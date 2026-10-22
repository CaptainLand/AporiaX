import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";

const guard = await readFile(new URL("../electron/gpu-guard.js", import.meta.url), "utf8");
const mainV2 = await readFile(new URL("../electron/main-v2.js", import.meta.url), "utf8");
const paper = await readFile(new URL("../src/welcome/paper-loop.js", import.meta.url), "utf8");
const welcome = await readFile(new URL("../src/welcome/WelcomeOverlay.jsx", import.meta.url), "utf8");
const browser = await readFile(new URL("../electron/workbench/browser-session.js", import.meta.url), "utf8");

assert.match(mainV2, /^import "\.\/gpu-guard\.js";/m);
assert.match(guard, /disable-gpu-process-crash-limit/);
assert.doesNotMatch(guard, /\.disableHardwareAcceleration\s*\(/);
assert.doesNotMatch(guard, /node:fs|readFileSync|writeFileSync|rmSync|appendSwitch\(["'](?:disable-gpu|use-angle)["']/);
// Exercise the actual module with an Electron-shaped app. Any attempted disk
// lookup of legacy fallback state fails, including a second installation.
const fakeApp = new EventEmitter();
const switches = [];
let accelerationDisabled = 0;
fakeApp.commandLine = { appendSwitch: name => switches.push(name) };
fakeApp.disableHardwareAcceleration = () => { accelerationDisabled++; };
fakeApp.getPath = () => { throw new Error("Must not inspect legacy fallback state"); };
const key = "__aporiaxGpuGuardSmokeApp";
globalThis[key] = fakeApp;
try {
  const source = guard.replace('import { app } from "electron";', `const app = globalThis.${key};`);
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  module.installGpuGuard(fakeApp);
  for (const type of ['GPU', 'Utility']) {
    for (const reason of ['clean-exit', 'killed', 'crashed', 'abnormal-exit', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']) {
      for (let count = 0; count < 5; count++) fakeApp.emit('child-process-gone', {}, { type, reason, exitCode: 1 });
    }
  }
  assert.equal(accelerationDisabled, 0, "no process exit may disable acceleration");
  assert.equal(fakeApp.listenerCount('child-process-gone'), 0, "no persistent fallback event handler");
  assert.deepEqual(switches, ['disable-gpu-process-crash-limit', 'disable-gpu-process-crash-limit']);
} finally {
  delete globalThis[key];
}
assert.match(paper, /WELCOME_MAX_FPS = 48/);
assert.match(welcome, /setTimeout/);
assert.match(browser, /ensureDebugger\(\)/);
assert.doesNotMatch(
  browser,
  /this\.wc\.debugger\.attach\("1\.3"\);\s*this\.ready = this\.wc\.loadURL/,
);

console.log("gpu guard smoke: PASS");

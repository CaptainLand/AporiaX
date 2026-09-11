import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const guard = await readFile(new URL("../electron/gpu-guard.js", import.meta.url), "utf8");
const mainV2 = await readFile(new URL("../electron/main-v2.js", import.meta.url), "utf8");
const paper = await readFile(new URL("../src/welcome/paper-loop.js", import.meta.url), "utf8");
const welcome = await readFile(new URL("../src/welcome/WelcomeOverlay.jsx", import.meta.url), "utf8");
const browser = await readFile(new URL("../electron/workbench/browser-session.js", import.meta.url), "utf8");

assert.match(mainV2, /^import "\.\/gpu-guard\.js";/m);
assert.match(guard, /disable-gpu-process-crash-limit/);
assert.match(guard, /disableHardwareAcceleration\(\)/);
assert.match(guard, /child-process-gone/);
assert.match(paper, /WELCOME_MAX_FPS = 48/);
assert.match(welcome, /setTimeout/);
assert.match(browser, /ensureDebugger\(\)/);
assert.doesNotMatch(
  browser,
  /this\.wc\.debugger\.attach\("1\.3"\);\s*this\.ready = this\.wc\.loadURL/,
);

console.log("gpu guard smoke: PASS");

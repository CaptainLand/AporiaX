import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const extensions = await readFile("src/settings/ExtensionsSettings.jsx", "utf8");
const main = await readFile("src/main.jsx", "utf8");
const preload = await readFile("electron/preload.cjs", "utf8");
const mainV2 = await readFile("electron/main-v2.js", "utf8");

for (const api of [
  "core?.capabilities",
  "core?.skills",
  "core?.mcp",
  "core?.plugins",
  "core?.extensionPolicy",
]) {
  assert(extensions.includes(api), `Extensions Center must consume ${api}`);
}
assert(extensions.includes('import "./extensions.css"'));
assert(extensions.includes("setExtensionPolicy"));
assert(extensions.includes("Extension source policy"));
assert(extensions.includes("MANAGED_SOURCES"));

assert(main.includes('import { ExtensionsSettings } from "./settings/ExtensionsSettings.jsx";'));
assert(main.includes('section === "extensions"'));
assert(main.includes('setSection("extensions")'));
assert(main.includes("<ExtensionsSettings"));
assert(main.includes('workspacePath={activeTask?.workspacePath || ""}'));
assert(main.includes("workspacePath={workspacePath}"));

assert(preload.includes('capabilities: (request = {}) =>'));
assert(preload.includes('extensionPolicy: (request = {}) =>'));
assert(preload.includes('setExtensionPolicy: (request) =>'));
assert(mainV2.includes('ipcMain.handle("core:capabilities"'));
assert(mainV2.includes('ipcMain.handle("core:extension-policy"'));
assert(mainV2.includes('ipcMain.handle("core:set-extension-policy"'));
assert(mainV2.includes('extensionSourceEnabled(policy, "skill")'));
assert(mainV2.includes('extensionSourceEnabled(policy, "mcp")'));

console.log("extensions center smoke: PASS");

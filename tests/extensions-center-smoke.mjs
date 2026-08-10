import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const extensions = await readFile("src/settings/ExtensionsSettings.jsx", "utf8");
const main = await readFile("src/main.jsx", "utf8");
const preload = await readFile("electron/preload.cjs", "utf8");
const mainV2 = await readFile("electron/main-v2.js", "utf8");

for (const api of ["core?.capabilities", "core?.skills", "core?.mcp", "core?.plugins"]) {
  assert(extensions.includes(api), `Extensions Center must consume ${api}`);
}
assert(extensions.includes('import "./extensions.css"'));
assert(extensions.includes("MCP v1"));
assert(extensions.includes("Capability Registry"));

assert(main.includes('import { ExtensionsSettings } from "./settings/ExtensionsSettings.jsx";'));
assert(main.includes('section === "extensions"'));
assert(main.includes('setSection("extensions")'));
assert(main.includes("<ExtensionsSettings"));
assert(main.includes('workspacePath={activeTask?.workspacePath || ""}'));
assert(main.includes("workspacePath={workspacePath}"));

assert(preload.includes('capabilities: (request = {}) =>'));
assert(preload.includes('ipcRenderer.invoke("core:capabilities", request)'));
assert(mainV2.includes('ipcMain.handle("core:capabilities"'));

console.log("extensions center smoke: PASS");

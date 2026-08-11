import { readFile, writeFile } from "node:fs/promises";

const path = "electron/agent-runtime-core.js";
let content = await readFile(path, "utf8");
const createBefore = '  const lspManager = createLspManager({ workspaceRoot, emit, signal });';
const createAfter = '  const lspManager = workspaceRoot\n    ? createLspManager({ workspaceRoot, emit, signal })\n    : null;';
if (!content.includes(createBefore)) throw new Error("LSP manager creation anchor not found.");
content = content.replace(createBefore, createAfter);
const closeBefore = '    await lspManager.closeAll().catch(() => undefined);';
const closeAfter = '    await lspManager?.closeAll().catch(() => undefined);';
if (!content.includes(closeBefore)) throw new Error("LSP manager cleanup anchor not found.");
content = content.replace(closeBefore, closeAfter);
await writeFile(path, content, "utf8");
console.log("LSP no-workspace lifecycle fixed");

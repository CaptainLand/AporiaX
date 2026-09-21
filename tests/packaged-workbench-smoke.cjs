const { app } = require("electron");
const assert = require("node:assert/strict");
const { mkdtemp } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let service;
const deadline = setTimeout(() => { console.error("Packaged workbench test timed out"); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  const version = require("../package.json").version;
  const archive = resolve(process.argv[2] || `release/v${version}/win-unpacked/resources/app.asar`);
  const workspacePath = await mkdtemp(join(tmpdir(), "aporiax-packaged-workbench-"));
  // Load the actual packaged modules; native PTY must resolve from app.asar.unpacked.
  const { createWorkbenchService } = await import(pathToFileURL(join(archive, "electron/workbench/service.js")));
  const { createSideChatService } = await import(pathToFileURL(join(archive, "electron/side-chat/service.js")));
  assert.equal(typeof createSideChatService, "function");
  service = createWorkbenchService({ getWindow: () => null });
  const request = (data) => service.request({ taskId: "packaged-smoke", workspacePath, ...data });
  const terminal = await request({ action: "new-terminal" });
  const record = service.resources.get(terminal.id);
  record.child.onData((data) => {
    if (data.includes("\x1b[c")) record.child.write("\x1b[?1;2c");
    if (data.includes("\x1b[6n")) record.child.write("\x1b[1;1R");
  });
  await delay(1000);
  await request({ action: "write", id: terminal.id, data: "Write-Output ('PACKAGED_' + 'TERMINAL_OK')\r" });
  let cursor = 0, output = "";
  const readDeadline = Date.now() + 15000;
  // PSReadLine emits many tiny redraw chunks; count wall time, not chunks.
  while (Date.now() < readDeadline) {
    const chunk = await request({ action: "read", id: terminal.id, cursor, waitMs: 300 });
    assert.equal(chunk.waitSupported, true);
    cursor = chunk.cursor; output += chunk.output;
    if (output.includes("PACKAGED_TERMINAL_OK")) break;
  }
  assert.match(output, /PACKAGED_TERMINAL_OK/);
  await request({ action: "stop", id: terminal.id, dispose: true });
  assert.equal(service.resources.size, 0);
  console.log(`PASS: packaged v${version} side-chat/workbench imports, native ConPTY spawn/write/output-triggered read/disposal from app.asar, temporary workspace only.`);
}).then(async () => { clearTimeout(deadline); await service?.closeAll(); app.exit(0); })
  .catch(async (error) => { console.error(error); clearTimeout(deadline); await service?.closeAll(); app.exit(1); });

const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let service, win, server;
app.whenReady().then(async () => {
  let beats = 0;
  server = createServer((req, res) => {
    if (req.url === "/beat") { beats++; res.end("ok"); return; }
    res.setHeader("Content-Type", "text/html");
    res.end('<title>Lifecycle fixture</title><script>setInterval(()=>fetch("/beat"),80)</script>');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true } });
  await win.loadURL("about:blank");
  win.webContents.setZoomFactor(1);
  const { createWorkbenchService } = await import(pathToFileURL(join(__dirname, "../electron/workbench/service.js")));
  service = createWorkbenchService({ getWindow: () => win });
  const context = { taskId: "lifecycle", workspacePath: process.cwd() };
  const request = (input) => service.request({ ...context, ...input });
  const created = await request({ action: "new-browser" });
  const b = service.resources.get(created.id);
  await request({ action: "navigate", id: b.id, url: "http://127.0.0.1:" + server.address().port });
  await delay(300);
  assert.ok(beats > 0);
  let unblock;
  const ready = b.ready;
  b.ready = new Promise((r) => { unblock = r; });
  const pendingLayout = request({ action: "layout", id: b.id, generation: 9999, rect: { x: 400, y: 0, width: 500, height: 600 } });
  await request({ action: "hide" });
  unblock();
  assert.equal(await pendingLayout, false, "A delayed layout must not reopen a hidden pane");
  assert.equal(b.view.getVisible(), false);
  b.ready = ready;
  const fresh = await request({ action: "layout", id: b.id, generation: 10000, rect: { x: 400, y: 0, width: 500, height: 600 } });
  assert.equal(b.view.getVisible(), true);
  assert.ok(fresh.width > 0, "A newer layout after hide must show the page without dragging the splitter");
  await request({ action: "stop", id: b.id, dispose: true });
  assert.equal(b.wc.isDestroyed(), true);
  assert.equal(service.resources.has(b.id), false);
  const stoppedAt = beats;
  await delay(350);
  assert.equal(beats, stoppedAt, "Closed page must not keep sending requests");
  console.log("PASS: delayed layout/hide, fresh generation, browser destruction and stopped heartbeat.");

  const term = await request({ action: "new-terminal" });
  const r = service.resources.get(term.id);
  r.child.onData((data) => {
    if (data.includes("\x1b[c")) r.child.write("\x1b[?1;2c");
    if (data.includes("\x1b[6n")) r.child.write("\x1b[1;1R");
  });
  const waitFor = async (marker) => {
    for (let i = 0; i < 100 && !r.output.includes(marker); i++) await delay(100);
    assert.ok(r.output.includes(marker), "Missing marker " + marker + ": " + r.output);
  };
  await delay(400);
  await request({ action: "write", id: term.id, data: "Write-Output ('READY_'+'SHELL')\r" });
  await waitFor("READY_SHELL");
  await request({ action: "write", id: term.id, data: 'node -e "console.log(\'LIVE_\'+\'NODE\');setInterval(()=>{},1000)"\r' });
  await waitFor("LIVE_NODE");
  await request({ action: "interrupt", id: term.id });
  await delay(300);
  await request({ action: "write", id: term.id, data: "Write-Output ('AFTER_'+'INTERRUPT')\r" });
  await waitFor("AFTER_INTERRUPT");
  assert.equal(r.status, "running");
  await request({ action: "write", id: term.id, data: "exit\r" });
  for (let i = 0; i < 100 && r.status !== "exited"; i++) await delay(100);
  assert.equal(r.status, "exited");
  assert.equal((await request({ action: "read", id: term.id })).status, "exited");
  await request({ action: "stop", id: term.id, dispose: true });
  assert.equal(service.resources.has(term.id), false);
  console.log("PASS: interrupt live child → reusable PowerShell prompt → explicit shell exit → readable exit state → tab disposal.");
}).then(async () => { await service?.closeAll(); win?.destroy(); server?.close(); app.exit(0); })
  .catch(async (error) => { console.error(error); await service?.closeAll(); win?.destroy(); server?.close(); app.exit(1); });

const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");
let server, win, service;
app.whenReady().then(async () => {
  server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<title>Workbench test</title><label>Message<input></label><button style="float:right" onclick="document.querySelector(\'h1\').textContent=document.querySelector(\'input\').value">Apply</button><h1>Start</h1>');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true } });
  await win.loadURL("about:blank");
  const { createWorkbenchService } = await import(pathToFileURL(join(__dirname, "../electron/workbench/service.js")));
  service = createWorkbenchService({ getWindow: () => win });
  const context = { taskId: "fixture", workspacePath: process.cwd() };
  const run = service.acquire({ ...context, emit: () => {} });
  const first = await run.browserRuntime.open({ url: `http://127.0.0.1:${server.address().port}` });
  const id = first.browserSessionId;
  if (process.env.WORKBENCH_PROBE === "1") {
    console.log(JSON.stringify(first));
    console.log(await service.resources.get(id).wc.executeJavaScript("JSON.stringify({viewport:[innerWidth,innerHeight], inputs:[...document.querySelectorAll('input')].map(e=>({labels:[...e.labels].map(l=>l.textContent),rect:e.getBoundingClientRect().toJSON(),style:getComputedStyle(e).visibility,hit:document.elementFromPoint(e.getBoundingClientRect().x+10,e.getBoundingClientRect().y+10)?.outerHTML}))})"));
    return;
  }
  await run.browserRuntime.fill({ label: "Message", value: "test-123" });
  console.log("native: filled");
  await run.browserRuntime.click({ role: "button", name: "Apply" });
  assert.match((await run.browserRuntime.snapshot()).visibleText, /test-123/);
  assert.equal(await service.resources.get(id).wc.executeJavaScript("typeof window.desktop"), "undefined");
  for (const zoom of [1, 1.25, 1.5, 2]) {
    console.log("native: zoom", zoom);
    win.webContents.setZoomFactor(zoom);
    const bounds = await service.request({ ...context, id, action: "layout", rect: { x: 50, y: 50, width: 420, height: 300 } });
    assert.equal(bounds.x, Math.round(50 * zoom));
    await run.browserRuntime.click({ role: "button", name: "Apply" });
  }
  await service.request({ ...context, id, action: "takeover" });
  console.log("native: takeover");
  await assert.rejects(run.browserRuntime.click({ text: "Apply" }), /USER_CONTROL/);
  await service.resources.get(id).wc.executeJavaScript("document.querySelector('input').value='test-456'; document.querySelector('button').click()");
  await service.request({ ...context, id, action: "release" });
  assert.match((await run.browserRuntime.snapshot()).visibleText, /test-456/);
  await service.request({ ...context, action: "hide" });
  assert.match((await run.browserRuntime.snapshot()).visibleText, /test-456/);
  await assert.rejects(service.request({ ...context, taskId: "other", id, action: "stop" }), /不属于/);
  const second = await run.browserRuntime.forOwner("builder").open({ url: `http://127.0.0.1:${server.address().port}` });
  assert.notEqual(first.browserSessionId, second.browserSessionId);
  const term = await service.request({ ...context, action: "new-terminal" });
  console.log("native: PTY started");
  await service.request({ ...context, id: term.id, action: "write", data: "Write-Output 'PTY-中文-OK'\r" });
  let out = "";
  for (let i = 0; i < 40 && !out.includes("PTY-中文-OK"); i++) { await new Promise((r) => setTimeout(r, 150)); out = (await service.request({ ...context, id: term.id, action: "read" })).output; }
  assert.match(out, /PTY-中文-OK/);
  await service.request({ ...context, id: term.id, action: "resize-terminal", cols: 65, rows: 18 });
  await service.request({ ...context, id: term.id, action: "write", data: "\x03" });
  await run.release();
  assert.equal(service.resources.get(id).owner, "user");
  console.log("PASS: native same-session input, takeover, four zooms/right-edge clicks, isolation, hide/reattach, independent agents, PTY Chinese/resize/Ctrl+C.");
}).then(async () => { await service?.closeAll(); win?.destroy(); server?.close(); app.exit(0); }).catch(async (e) => { console.error(e); await service?.closeAll(); win?.destroy(); server?.close(); app.exit(1); });

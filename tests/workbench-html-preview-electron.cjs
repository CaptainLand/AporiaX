const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { request: httpRequest } = require("node:http");

// Isolated process/profile: never start AporiaX or touch an account/provider.
const profile = join(tmpdir(), `aporiax-html-preview-profile-${process.pid}`);
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error("HTML preview test timed out"); app.exit(1); }, 25000);
const read = (url, options = {}) => new Promise((accept, reject) => {
  const request = httpRequest(url, options, response => {
    const chunks = [];
    response.on("data", chunk => chunks.push(chunk));
    response.on("end", () => accept({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
  });
  request.on("error", reject); request.end();
});

let service, window, base, direct;
app.whenReady().then(async () => {
  const { createWorkbenchService } = await import(pathToFileURL(resolve("electron/workbench/service.js")));
  const { createHtmlPreview } = await import(pathToFileURL(resolve("electron/workbench/html-preview.js")));
  base = await mkdtemp(join(tmpdir(), "aporiax-html-preview-test-"));
  const workspace = join(base, "workspace");
  const root = join(workspace, "page");
  await mkdir(root, { recursive: true });
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "assets", "style.css"), "#result { color: rgb(17, 120, 83); }");
  await writeFile(join(root, "assets", "main.js"), "document.querySelector('#result').textContent = 'Script rendered';");
  await writeFile(join(root, "assets", "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="green"/></svg>');
  const html = '<!doctype html><meta charset="utf-8"><title>HTML Preview</title><link rel="stylesheet" href="assets/style.css"><p id="result">Loading</p><img src="assets/image.svg"><script type="module" src="assets/main.js"></script>';
  const filename = "展示 #1 %.HTML";
  await writeFile(join(root, filename), html);
  await writeFile(join(root, "index.htm"), html);
  await writeFile(join(root, ".env"), "PRIVATE_FIXTURE");
  await writeFile(join(root, "credentials.json"), "PRIVATE_FIXTURE");
  await writeFile(join(root, "private.txt"), "PRIVATE_FIXTURE");
  await writeFile(join(workspace, "outside.html"), "OUTSIDE_PREVIEW_DIRECTORY");
  await writeFile(join(base, "outside.html"), "OUTSIDE_WORKSPACE");
  direct = await createHtmlPreview(workspace, `page/${filename}`);
  const url = new URL(direct.url);
  const prefix = direct.url.slice(0, direct.url.lastIndexOf("/") + 1);
  assert.equal((await read(direct.url)).status, 200);
  assert.equal((await read(direct.url, { method: "HEAD" })).text, "");
  assert.equal((await read(prefix + "assets/style.css")).status, 200);
  assert.equal((await read(prefix + "assets/main.js")).headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal((await read(direct.url)).headers["referrer-policy"], "no-referrer");
  for (const suffix of [".env", "credentials.json", "private.txt", "assets/", "%2e%2e/outside.html", "assets/%2e%2e/%2e%2e/outside.html", "%5c..%5coutside.html", "C:%5cWindows%5cwin.ini", "%00.html"]) {
    assert.notEqual((await read(prefix + suffix)).status, 200, suffix);
  }
  assert.equal((await read(url.origin + "/wrong-token/index.html")).status, 404);
  assert.equal((await read(direct.url, { headers: { Host: "attacker.invalid" } })).status, 403);
  assert.equal((await read(direct.url, { headers: { Origin: "https://attacker.invalid" } })).status, 403);
  assert.equal((await read(direct.url, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await read(direct.url, { method: "POST" })).status, 405);
  await assert.rejects(createHtmlPreview(workspace, "../outside.html"));
  await assert.rejects(createHtmlPreview(workspace, "page/private.txt"));
  await direct.close(); await direct.close();
  await assert.rejects(read(direct.url));

  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  service = createWorkbenchService({ getWindow: () => window });
  const context = { taskId: "html-preview-fixture", workspacePath: workspace };
  const resource = await service.request({ ...context, action: "preview-html", path: `page/${filename}` });
  assert.equal(resource.kind, "browser");
  assert.equal(resource.owner, "user");
  assert.equal(resource.title, "HTML Preview");
  const repeated = await service.request({ ...context, action: "preview-html", path: join(root, filename) });
  assert.equal(repeated.id, resource.id, "Repeated clicks reuse the same scoped browser tab");
  const session = service.resources.get(resource.id);
  await new Promise(resolve => setTimeout(resolve, 200));
  const rendered = await session.wc.executeJavaScript(`({ text: document.querySelector('#result').textContent, color: getComputedStyle(document.querySelector('#result')).color, image: document.querySelector('img').naturalWidth, desktop: typeof window.desktop, require: typeof require, process: typeof process })`);
  assert.deepEqual(rendered, { text: "Script rendered", color: "rgb(17, 120, 83)", image: 20, desktop: "undefined", require: "undefined", process: "undefined" });
  const shortExtension = await service.request({ ...context, action: "preview-html", path: "page/index.htm" });
  assert.equal(shortExtension.kind, "browser");
  assert.deepEqual(await service.request({ ...context, taskId: "different-task", action: "navigate", id: resource.id, url: "https://example.invalid" }), { missing: true });
  await service.request({ ...context, action: "stop", id: resource.id, dispose: true });
  await assert.rejects(read(resource.url));
  console.log("PASS: HTML opens in an isolated Workbench browser; styles, module scripts and images render; private/outside files and cross-origin requests are blocked; closing the tab shuts down its preview server.");
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(deadline);
  await direct?.close(); await service?.closeAll(); window?.destroy();
  if (base) await rm(base, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});

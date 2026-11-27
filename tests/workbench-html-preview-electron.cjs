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
  const { createNativeToolExecutor } = await import(pathToFileURL(resolve("electron/runtime/native-tool-executor.js")));
  const { verifyExistingTarget } = await import(pathToFileURL(resolve("electron/runtime/workspace-runtime.js")));
  const { dispatchNativeTool } = await import(pathToFileURL(resolve('electron/runtime/tool-dispatcher.js')));
  const { createPermissionPolicy } = await import(pathToFileURL(resolve('electron/agent-core.js')));
  const { TOOL_REGISTRY } = await import(pathToFileURL(resolve('electron/runtime/native-tool-catalog.js')));
  const { createFullAutoApproval } = await import(pathToFileURL(resolve('electron/runtime/full-auto-approval.js')));
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
  const agentContext = { ...context, taskId: 'agent-html-presentation', emit() {} };
  const run = service.acquire(agentContext);
  const unused = async () => assert.fail('HTML presentation should not use shell, search or write services');
  const present = createNativeToolExecutor({verifyExistingTarget,verifyWritableTarget:unused,searchWorkspaceText:unused,
    calculateLineChanges:unused,runGitCommand:unused});
  const { modelResult } = await present({toolName:'present_to_user',input:{path:'page/index.htm'},
    workspaceRoot:workspace,workbenchPresent:run.present,browserRuntime:run.browserRuntime});
  assert.equal(modelResult.browser,true);
  assert.deepEqual(modelResult.files,[]);
  assert.equal(modelResult.htmlPreviews[0].verifiedInteractions,false);
  const agentPreview = [...service.resources.values()].find(r=>r.taskId===agentContext.taskId);
  assert.equal(agentPreview.state().present,true);
  assert.equal(await agentPreview.wc.executeJavaScript("document.querySelector('#result').textContent"),'Script rendered');
  await run.release();
  assert.equal((await read(modelResult.htmlPreviews[0].previewUrl)).status,200,'delivered preview remains open');
  await service.request({ ...agentContext, action:'stop',id:agentPreview.id,dispose:true });
  await assert.rejects(read(modelResult.htmlPreviews[0].previewUrl));

  await writeFile(join(root, 'interactive.html'), `<!doctype html><input id="name"><select id="choice"><option value="a">A</option><option value="b">B</option></select>
    <button id="apply">Apply</button><a id="external" href="${resource.url}">Other browser origin</a><p id="receipt">Ready</p>
    <script>document.querySelector('#apply').onclick = () => { document.querySelector('#receipt').textContent = document.querySelector('#name').value + ':' + document.querySelector('#choice').value; };
    document.addEventListener('keydown', event => { if (event.key === 'k') document.querySelector('#receipt').textContent += ':key'; });</script>`);
  for (const approvalMode of ['approve-all', 'full-auto']) {
    let prompts = 0;
    const localContext = { ...agentContext, taskId: `interactive-${approvalMode}` };
    const owned = service.acquire(localContext);
    const approve = createFullAutoApproval({ approvalMode, workspaceRoot: workspace, requestApproval: async () => { prompts++; return { approved: false }; } });
    const act = async (toolName, input) => (await dispatchNativeTool({
      toolCall: { id: toolName, function: { name: toolName, arguments: JSON.stringify(input) } },
      registry: TOOL_REGISTRY, permissionPolicy: createPermissionPolicy('workspace-write'), approvalMode,
      requestApproval: approve, executionMode: 'direct', parseArguments: call => JSON.parse(call.function.arguments), executeAuthorized: present,
      executeContext: { workspaceRoot: workspace, workbenchPresent: owned.present, browserRuntime: owned.browserRuntime },
    })).modelResult;
    const demo = await act('present_to_user', { path: 'page/interactive.html' });
    const demoUrl = demo.htmlPreviews[0].previewUrl;
    assert.match((await read(demoUrl)).headers['content-security-policy'], /connect-src 'self'/);
    assert.equal((await act('browser_fill', { selector: '#name', value: 'test' })).active, true);
    assert.equal((await act('browser_select', { selector: '#choice', values: ['b'] })).selected[0], 'b');
    assert.match((await act('browser_click', { selector: '#apply' })).visibleText, /test:b/);
    assert.match((await act('browser_press', { selector: '#name', key: 'k' })).visibleText, /test:b:key/);
    await act('browser_click', { selector: '#external' });
    assert.equal((await owned.browserRuntime.snapshot()).url, demoUrl, 'owned preview must not follow external navigation');
    assert.equal(prompts, 0, 'local interactions must not ask');
    const demoId = (await owned.browserRuntime.snapshot()).browserSessionId;
    await act('browser_open', { url: resource.url });
    await assert.rejects(act('browser_click', { selector: '#result' }), approvalMode === 'approve-all' ? { code: 'APPROVE_ALL_SKIPPED' } : /user rejected/);
    assert.equal(prompts, approvalMode === 'full-auto' ? 1 : 0);
    await owned.release();
    assert.equal((await read(demoUrl)).status, 200);
    const nextRun = service.acquire(localContext);
    await nextRun.browserRuntime.snapshot();
    assert.equal(nextRun.browserRuntime.bindAutomaticPreviewAction('browser_click'), null, 'a new run cannot inherit previous preview authorization');
    await nextRun.release();
    await service.request({ ...localContext, action: 'stop', id: demoId, dispose: true });
  }
  assert.deepEqual(await service.request({ ...context, taskId: "different-task", action: "navigate", id: resource.id, url: "https://example.invalid" }), { missing: true });
  await service.request({ ...context, action: "stop", id: resource.id, dispose: true });
  await assert.rejects(read(resource.url));
  console.log("PASS: HTML preview rendering, run-owned click/fill/select/press in both automatic modes, cross-origin separation, and preview lifecycle.");
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(deadline);
  await direct?.close(); await service?.closeAll(); window?.destroy();
  if (base) await rm(base, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});

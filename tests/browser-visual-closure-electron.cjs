const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createServer } = require('node:http');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let root, session, window, server;
const originalFetch = globalThis.fetch;
const timeout = setTimeout(() => { console.error('Browser closure timed out'); app.exit(1); }, 60000);
(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'aporiax-browser-closure-'));
  app.setPath('userData', join(root, 'profile'));
  await app.whenReady();
  const { WorkbenchBrowserSession } = await import('../electron/workbench/browser-session.js');
  const { installWorkbenchProvider } = await import('../electron/workbench/runtime-provider.js');
  const { runHarness } = await import('../electron/agent-runtime-core.js');
  const { compileProviderWire } = await import('../electron/runtime/native-provider-codec.js');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(join(root, 'sample.png'), png);
  const html = `<!doctype html><meta charset="utf-8"><title>Image conversion fixture</title><style>body{font:16px sans-serif;background:#f2f4f7;padding:32px}#drop{padding:25px;background:white}canvas{background:#378ad2}</style><h1>Image converter</h1><input id="file" type="file" hidden><select id="format"><option value="png">PNG</option><option value="jpeg">JPEG</option></select><button id="convert">Convert</button><div id="drop">Drop an image</div><p id="result">Waiting</p><canvas width="320" height="160"></canvas><script>let file;document.querySelector('#file').onchange=e=>{file=e.target.files[0];document.querySelector('#result').textContent=file.name};document.querySelector('#drop').ondrop=e=>{e.preventDefault();document.querySelector('#result').textContent='Dropped '+e.dataTransfer.files[0].name};document.querySelector('#convert').onclick=()=>{let canvas=document.querySelector('canvas');canvas.getContext('2d').fillRect(20,20,100,80);window.output=canvas.toDataURL('image/'+document.querySelector('#format').value);document.querySelector('#result').textContent=file.name+' converted to '+document.querySelector('#format').value};</script>`;
  server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({ show: false });
  session = new WorkbenchBrowserSession({ taskId: 'closure', workspacePath: root, owner: 'agent' });
  window.contentView.addChildView(session.view);
  session.view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  session.view.setVisible(true);
  window.showInactive();
  await session.setViewport(800, 600);
  installWorkbenchProvider({ acquire: () => ({ browserRuntime: session, release: async () => {} }) });
  const calls = [
    ['browser_open', { url }], ['browser_upload', { selector: '#file', paths: ['sample.png'] }],
    ['browser_select', { selector: '#format', values: ['JPEG'], by: 'label' }],
    ['browser_click', { selector: '#convert' }], ['browser_screenshot', {}],
  ];
  let count = 0, imageSeen = false, transportFailure;
  const sse = delta => new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
  globalThis.fetch = async (target, init) => {
    assert.match(String(target), /^https:\/\/vision-fixture.invalid\//);
    const body = JSON.parse(init.body);
    if (count < calls.length) {
      const [name, input] = calls[count++];
      return sse({ tool_calls: [{ index: 0, id: `call-${count}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
    }
    try {
    const images = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
    assert.equal(images.length, 1, 'actual screenshot pixels must reach the next model request');
    assert.match(images[0].image_url.url, /^data:image\/png;base64,/);
    assert(!JSON.stringify(body).includes('aporiaBrowserEvidence'));
    const receipt = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    assert(receipt.every(value => !value.error), JSON.stringify(receipt));
    assert.match(receipt[3].visibleText, /sample.png converted to jpeg/);
    assert.equal(receipt[4].visualEvidence.width, 800);
    for (const protocol of ['responses', 'anthropic-messages']) {
      const wire = compileProviderWire({ id: 'codec', baseUrl: 'https://fixture.invalid/v1', protocol }, { ...body, model: 'fixture', tools: [] });
      assert(JSON.stringify(wire.body).includes('image/png'), `${protocol} must preserve screenshot pixels`);
    }
    imageSeen = true;
    } catch (error) { transportFailure = error; }
    return sse({ content: '转换结果已生成。' });
  };
  const result = await runHarness({ taskId: 'closure', workspacePath: root,
    provider: { id: 'vision-fixture', name: 'Fixture', vendor: 'openai', baseUrl: 'https://vision-fixture.invalid/v1', apiKey: 'fixture-only', models: [{ id: 'fixture', supportsImages: true, supportsTools: true, contextWindow: 128000 }] },
    modelId: 'fixture', permission: 'workspace-write', approvalMode: 'full-auto',
    messages: [{ role: 'user', content: 'Test the local image converter by uploading sample.png, selecting JPEG and looking at a screenshot.' }], requestApproval: async () => ({ approved: true }), onEvent: event => { if (['tool.started', 'tool.completed', 'turn.failed'].includes(event.type)) console.log(event.type, event.tool, event.success, event.detail || event.error || ''); },
  });
  if (transportFailure) throw transportFailure;
  assert.equal(result.status, 'completed', result.content); assert(imageSeen);
  assert.match(await session.wc.executeJavaScript('window.output'), /^data:image\/jpeg;base64,/);
  await session.upload({ selector: '#drop', mode: 'drop', files: [{ name: 'sample.png', mimeType: 'image/png', data: png.toString('base64'), bytes: png.length }] });
  assert.match((await session.snapshot()).visibleText, /Dropped sample.png/);
  await session.takeover(); await assert.rejects(session.screenshot(), /BROWSER_USER_CONTROL/);
  installWorkbenchProvider(null);
  console.log('PASS real Electron form/upload/select/drop/conversion/screenshot -> Harness image request -> all provider codecs; private browser ownership preserved. Model transport mocked; no account calls.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(timeout); globalThis.fetch = originalFetch;
  await session?.close(); window?.destroy(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  if (root) await fs.rm(root, { recursive: true, force: true }).catch(error => { if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error; });
  app.exit(process.exitCode || 0);
});

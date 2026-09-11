const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
app.disableHardwareAcceleration();
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aporiax-vision-request-'));
  app.setPath('userData', root);
  await app.whenReady();
  const originalFetch = globalThis.fetch;
  try {
    const { prepareVisionProxyRequest } = await import('../electron/vision-proxy.js');
    const { getDesktopAccountRuntime } = await import('../electron/account/register-desktop-account-ipc.js');
    const account = getDesktopAccountRuntime();
    let calls = [];
    let ready = false;
    account.fetchModelGateway = async (route, init) => {
      calls.push({ route, method: init.method });
      if (route === '/v1/capabilities/vision') return Response.json(ready
        ? { status:'ready', verification:'configuration', model:{id:'aporia-cloud-vision',name:'server-selected-vision',supportsImages:true} }
        : { status:'unavailable' });
      assert.equal(route, '/v1/chat/completions');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'aporia-cloud-vision');
      return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'cloud observation'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}});
    };
    globalThis.fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return Response.json({choices:[{message:{content:'local observation'}}]});
    };
    const request = { providerId:'ds',modelId:'deepseek-v4.1-flash',messages:[{role:'user',content:'look',attachments:[{kind:'image',dataUrl:'data:image/png;base64,aGVsbG8='}]}] };
    const records = [{id:'ds',baseUrl:'https://unused.invalid',models:[{id:request.modelId,imageInput:'native',supportsImages:false}]}];
    const save = () => fs.writeFile(path.join(root,'aporiax-providers.json'), JSON.stringify({providers:records}));
    await save();
    assert.equal(await prepareVisionProxyRequest(request), request);
    assert.equal(calls.length, 0, 'native preview images bypass every proxy');
    records[0].models[0].imageInput = 'text';
    await save();
    await assert.rejects(() => prepareVisionProxyRequest(request), /VISION_NOT_CONFIGURED/);
    assert.equal(calls.length, 0, 'unconfigured BYOK does not borrow Cloud or transmit images');
    records.push({id:'local',vendor:'local',baseUrl:'http://127.0.0.1:9999/v1',models:[{id:'custom-vision',imageInput:'native'}]});
    await save();
    const proxied = await prepareVisionProxyRequest(request);
    assert.equal(proxied.visionProxy.providerId,'local');
    assert.equal(calls[0].body.model,'custom-vision');
    assert.match(proxied.messages[0].content,/local observation/);
    assert.equal(proxied.messages[0].attachments.length,0);
    calls=[];
    await assert.rejects(() => prepareVisionProxyRequest({...request,providerId:'aporia-cloud'}), /APORIA_CLOUD_VISION_NOT_READY/);
    assert.equal(calls.length,1);
    assert.equal(calls[0].route,'/v1/capabilities/vision');
    ready=true; calls=[];
    const cloud = await prepareVisionProxyRequest({...request,providerId:'aporia-cloud'});
    assert.deepEqual(calls.map(x=>x.route),['/v1/capabilities/vision','/v1/chat/completions']);
    assert.match(cloud.messages[0].content,/server-selected-vision/);
    assert.match(cloud.messages[0].content,/cloud observation/);
    console.log('Real Electron vision request path: native bypass, BYOK routing, no implicit Cloud, readiness gating, server-selected model label: PASS');
  } finally {
    globalThis.fetch=originalFetch;
    assert(path.relative(os.tmpdir(),root).startsWith('aporiax-vision-request-'));
    await fs.rm(root,{recursive:true,force:true});
  }
})().then(()=>app.exit(0),error=>{ console.error(error);app.exit(1); });

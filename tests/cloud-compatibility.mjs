import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cloudModelAvailability, cloudVisionAvailability, projectCloudProvider } from '../shared/cloud-availability.js';
import { getAvailableModels } from '../src/models/model-catalog.js';
import { createAporiaCloudProvider } from '../electron/provider-config.js';
import { loadCloudEndpoints, sessionMatchesEndpoints } from '../electron/account/cloud-endpoints.js';
import { callModelProvider } from '../electron/runtime/provider-stream.js';
import { withDurableRun } from '../electron/runtime/durable-run.js';
const results = [];
async function test(name, fn) { try { await fn(); results.push({ name, passed: true }); console.log('PASS', name); } catch(e) { results.push({ name, passed:false, error:String(e) }); console.error('FAIL', name, e); } }
const cloud = createAporiaCloudProvider(), model = cloud.models[0].id;
const catalog = [{ slug: model, enabled:true, freeTierAllowed:true }];
const signedIn = { status:'authenticated', models:catalog, quota:{ remainingRatio:1 } };
const temp = await mkdtemp(join(tmpdir(),'aporia-cloud-compat-'));
const endpointOptions = { webBaseUrl:'https://web.example.invalid',apiBaseUrl:'https://api.example.invalid',modelGatewayBaseUrl:'https://model.example.invalid',endpointManifest:join(temp,'missing.json') };
const json = data => new Response(JSON.stringify(data), { headers:{'content-type':'application/json'} });
const sse = (done=true) => new Response('data: '+JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}})+'\n\n'+(done?'data: [DONE]\n\n':''));
await test('authenticated account with an empty server catalog does not enable Flash', () => {
 const records=[projectCloudProvider(cloud,{...signedIn,models:[]})];
 assert(getAvailableModels(records).every(m=>m.disabled)); assert.match(records[0].models[0].disabledReasonZh,/未启用/);
 assert(getAvailableModels([{...cloud,accountStatus:'authenticated'}]).every(m=>m.disabled));
});
await test('service, provider, quota and model denials remain independent of login', () => {
 for(const reason of ['PROVIDER_NOT_CONFIGURED','QUOTA_UNAVAILABLE','PRICING_REVIEW_REQUIRED','MODEL_DISABLED']) {
  const state=cloudModelAvailability({...signedIn,gatewayCapabilities:{protocolVersion:1,models:[{slug:model,available:false,reason}]}},model);
  assert.equal(state.available,false); assert.equal(state.reason,reason);
 }
 assert.equal(cloudModelAvailability({...signedIn,gatewayStatus:'unavailable'},model).available,false);
 assert.equal(cloudModelAvailability({...signedIn,quota:{availableRatio:0,remainingRatio:1}},model).available,false);
});
await test('confirmed legacy catalog works without pretending upstream health is verified', () => {
 assert.equal(cloudModelAvailability(signedIn,model).verification,'legacy-catalog-only');
 const p=projectCloudProvider(cloud,signedIn); assert.equal(getAvailableModels([p])[0].disabled,false);
 const own={id:'local',models:[]}; assert.equal(projectCloudProvider(own,{}),own);
});
await test('native Flash Vision requires both catalog and explicit image capability', () => {
 const state={...signedIn,gatewayCapabilities:{protocolVersion:1,models:[{slug:model,supportsImages:true,available:true}]}};
 assert.equal(cloudVisionAvailability(state).available,true);
 assert.equal(cloudVisionAvailability({...state,models:[]}).available,false);
 assert.equal(cloudVisionAvailability({...state,status:'signed-out'}).available,false);
 assert.equal(cloudVisionAvailability({...state,gatewayCapabilities:{protocolVersion:1,models:[{slug:model,supportsImages:false,available:true}]}}).available,false);
 assert.equal(cloudVisionAvailability({...state,gatewayStatus:'unavailable'}).available,false);
 assert.equal(cloudVisionAvailability({...state,gatewayCapabilities:null}).available,false);
});
await test('all three deployment URLs must be explicit; missing configuration is not silently promoted', async () => {
 assert.equal(loadCloudEndpoints({endpointManifest:join(temp,'none')},{}).configured,false);
 assert.throws(()=>loadCloudEndpoints({apiBaseUrl:'https://a.invalid',endpointManifest:join(temp,'none')},{}),/INCOMPLETE/);
 for(const webBaseUrl of ['http://outside.invalid','https://u:p@host.invalid','https://host.invalid?q=1']) assert.throws(()=>loadCloudEndpoints({...endpointOptions,webBaseUrl},{}));
 const p=loadCloudEndpoints(endpointOptions,{});assert.equal(p.configured,true);
 const manifest=join(temp,'endpoints.json');await writeFile(manifest,JSON.stringify({version:1,accountWebUrl:p.accountWebUrl,accountApiUrl:p.accountApiUrl,modelGatewayUrl:p.modelGatewayUrl}));
 assert.equal(loadCloudEndpoints({endpointManifest:manifest},{}).sessionScope,p.sessionScope);
});
await test('refresh credentials are bound to the configured deployment', () => {
 const a=loadCloudEndpoints(endpointOptions,{}),b=loadCloudEndpoints({...endpointOptions,apiBaseUrl:'https://other.invalid'},{});
 assert(sessionMatchesEndpoints({endpointScope:a.sessionScope},a)); assert(!sessionMatchesEndpoints({endpointScope:a.sessionScope},b)); assert(!sessionMatchesEndpoints({},a));
});
await test('actual account runtime stays signed in with models empty and never dispatches inference', async () => {
 const original=globalThis.fetch;
 globalThis.__cloudTestElectron={app:{getPath:()=>temp,getVersion:()=>"1.0.0-preview.4"},dialog:{},shell:{},safeStorage:{isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from(v),decryptString:b=>b.toString()}};
 const p=loadCloudEndpoints(endpointOptions,{});await writeFile(join(temp,'aporiax-account-session.json'),JSON.stringify({endpointScope:p.sessionScope,encryptedRefreshToken:Buffer.from('fixture-refresh').toString('base64')}));
 let modelCalls=0;let enabled=false;let capabilityFailure=false;let visionEnabled=false;
 const sent=[];
 await writeFile(join(temp,'aporiax-tasks.json'),'PRIVATE_CONVERSATION_PROJECT_SENTINEL');
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(url);
  assert.equal(new Headers(init.headers).get("X-Aporia-Desktop-Version"),"1.0.0-preview.4");
  sent.push({path:u.pathname,method:init.method||'GET',body:init.body});
  if(u.pathname==='/auth/refresh') return json({accessToken:'fixture-access',refreshToken:'fixture-refresh'});
  if(u.pathname==='/me')return json({user:{id:'fixture-user',displayName:'Fixture'},session:{deviceId:'device'},identities:[]});
  if(u.pathname==='/models')return json(enabled?catalog:[]);
  if(u.pathname==='/quota/weekly')return json({remainingRatio:1,availableRatio:1});
  if(u.pathname==='/capabilities')return json({protocolVersion:1,remote:{supported:true}});
  if(u.pathname==='/v1/capabilities')return capabilityFailure?new Response('',{status:503}):json({protocolVersion:1,models:enabled?[{slug:model,available:true,supportsImages:visionEnabled}]:[]});
  if(u.pathname==='/devices')return json([{id:'device',remoteEnabled:true}]);
  if(u.pathname==='/usage/summary')return json({unresolvedRequestCount:2});
  if(u.pathname==='/v1/chat/completions'){modelCalls++;assert(new Headers(init.headers).get('idempotency-key'));return sse();}
  throw Error('Unexpected fixture route '+u.pathname);
 };
 let source=await readFile(new URL('../electron/account/desktop-account-runtime.js',import.meta.url),'utf8');
 source=source.replace('import { app, safeStorage, shell } from "electron";','const { app, safeStorage, shell } = globalThis.__cloudTestElectron;');
 source=source.replace(/from "(\.\.?\/[^\"]+)"/g,(_,p)=>'from '+JSON.stringify(pathToFileURL(resolve('electron/account',p)).href));
 const {createDesktopAccountRuntime}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const runtime=createDesktopAccountRuntime(endpointOptions);
 try {
  const snapshot=await runtime.getSnapshot();assert.equal(snapshot.status,'authenticated');assert.equal(snapshot.models.length,0);
  assert(sent.every(call=>['/auth/refresh','/me','/models','/quota/weekly','/capabilities','/v1/capabilities','/devices','/usage/summary'].includes(call.path)));
  assert(sent.every(call=>call.method==='GET'||(call.path==='/auth/refresh'&&call.method==='POST')));
  assert.doesNotMatch(JSON.stringify(sent),/PRIVATE_CONVERSATION_PROJECT_SENTINEL/);
  await assert.rejects(runtime.fetchModelGateway('/v1/chat/completions',{body:JSON.stringify({model})}),/MODEL_NOT_AVAILABLE/);assert.equal(modelCalls,0);
  for (const name of ['setRemoteEnabled','setRemoteFileAccess','syncRemoteTasks','pollRemoteCommands','claimRemoteCommand','acknowledgeRemoteCommand','executeRemoteFileCommand']) assert.equal(name in runtime,false, name+' must not exist');
  await assert.rejects(runtime.fetchModelGateway('/remote/desktop/tasks',{method:'PUT',body:'private fixture'}),/PATH_NOT_ALLOWED/);
  enabled=true;visionEnabled=true;await runtime.refresh();
  const imageBody={model,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}]}]};
  await runtime.fetchModelGateway('/v1/chat/completions',{body:JSON.stringify(imageBody)});assert.equal(modelCalls,1);
  assert(getAvailableModels([projectCloudProvider(cloud,await runtime.getSnapshot())]).every(m=>!m.disabled));
  visionEnabled=false;await runtime.refresh();await assert.rejects(runtime.fetchModelGateway('/v1/chat/completions',{body:JSON.stringify(imageBody)}),/MODEL_NOT_AVAILABLE/);assert.equal(modelCalls,1);
  await assert.rejects(runtime.fetchModelGateway('/v1/chat/completions',{body:JSON.stringify({model:'aporia-cloud-vision'})}),/MODEL_NOT_AVAILABLE/);
  enabled=true;await runtime.refresh();assert.equal((await runtime.fetchModelGateway('/v1/chat/completions',{body:JSON.stringify({model})})).status,200);assert.equal(modelCalls,2);
  capabilityFailure=true;assert.equal((await runtime.refresh()).status,'authenticated');
  await assert.rejects(runtime.fetchModelGateway('/v1/chat/completions',{body:JSON.stringify({model})}),/MODEL_SERVICE_UNVERIFIED/);
 } finally {runtime.close();globalThis.fetch=original;delete globalThis.__cloudTestElectron;}
});
const requestBody={model,messages:[{role:'user',content:'fixture'}]};
await test('actual Cloud provider records task/run/agent IDs, never prompts in correlation headers',async()=>{
 const seen=[];const provider={...cloud,authenticatedFetch:async(path,init)=>{seen.push(new Headers(init.headers));return sse();}};
 await withDurableRun({requestTrace:{taskId:'task-1',runId:'run-1'}},()=>callModelProvider({provider,body:requestBody,requestTrace:{agentId:'builder-1'}}));
 assert.equal(seen[0].get('x-aporia-task-id'),'task-1');assert.equal(seen[0].get('x-aporia-agent-id'),'builder-1');assert.match(seen[0].get('idempotency-key'),/^[a-f0-9-]{36}$/);assert(![...seen[0].values()].includes('fixture'));
});
await test('ambiguous transport retry reuses the idempotency key; known duplicate does not regenerate',async()=>{
 const seen=[];const provider={...cloud,authenticatedFetch:async(_p,init)=>{seen.push(new Headers(init.headers));if(seen.length===1)throw new TypeError('fetch failed');return json({error:{message:'REQUEST_ALREADY_EXISTS'}});}};
 // Status must be an explicit conflict, never a successful empty stream.
 provider.authenticatedFetch=async(_p,init)=>{seen.push(new Headers(init.headers));if(seen.length===1)throw new TypeError('fetch failed');return new Response(JSON.stringify({error:{message:'REQUEST_ALREADY_EXISTS'}}),{status:409});};
 await assert.rejects(callModelProvider({provider,body:requestBody}),/REQUEST_ALREADY_EXISTS/);
 assert.equal(seen.length,2);assert.equal(seen[0].get('idempotency-key'),seen[1].get('idempotency-key'));
});
await test('billing status does not overwrite OpenAI usage with a different schema', async()=>{
 const events=[];
 const wire='data: '+JSON.stringify({choices:[{delta:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3,prompt_cache_hit_tokens:2}})+'\n\nevent: aporia_billing\ndata: '+JSON.stringify({requestId:'owned',usageState:'provider',chargedMicros:1404,usage:{inputTokens:10,outputTokens:3,cachedInputTokens:2}})+'\n\ndata: [DONE]\n\n';
 const result=await callModelProvider({provider:{...cloud,authenticatedFetch:async()=>new Response(wire)},body:requestBody,onEvent:e=>events.push(e)});
 assert.equal(result.usage.prompt_tokens,10); assert.equal(result.usage.completion_tokens,3);
 assert.equal(events.find(e=>e.type==='response.cloud.billing').chargedMicros,1404);
 const pkg=JSON.parse(await readFile('package.json','utf8')); assert(pkg.build.files.includes('shared/**/*'));
});
await test('explicit pending accounting prevents a new automatic inference after HTTP failure',async()=>{
 let calls=0;
 const provider={...cloud,authenticatedFetch:async()=>{calls++;return new Response(JSON.stringify({error:{message:'APORIA_PROVIDER_TIMEOUT'},request:{usageState:'pending'}}),{status:504});}};
 await assert.rejects(callModelProvider({provider,body:requestBody}),e=>e.cloudUsageState==='pending'&&!e.retryable); assert.equal(calls,1);
});
await test('Cloud finish_reason without DONE cannot release a successful response',async()=>{
 await assert.rejects(callModelProvider({provider:{...cloud,authenticatedFetch:async()=>sse(false)},body:requestBody}),/INCOMPLETE/);
});
await test('an explicit rejected retry has a new attempt key and a stable logical request ID',async()=>{
 const seen=[],parent='11111111-1111-4111-8111-111111111111';
 const provider={...cloud,authenticatedFetch:async(_p,init)=>{seen.push(new Headers(init.headers));return seen.length===1?new Response(JSON.stringify({error:{message:'APORIA_MODEL_BUSY'},request:{requestId:parent,usageState:'not-dispatched',billing:'released',chargedMicros:0}}),{status:429,headers:{'x-aporia-request-id':parent}}):sse();}};
 await callModelProvider({provider,body:requestBody});assert.equal(seen.length,2);
 assert.notEqual(seen[0].get('idempotency-key'),seen[1].get('idempotency-key'));assert.equal(seen[0].get('x-aporia-logical-request-id'),seen[1].get('x-aporia-logical-request-id'));assert.equal(seen[1].get('x-aporia-retry-of'),parent);
});

await test('proxy 502/504 retries retain identity and cannot dispatch a second inference', async()=>{
 for(const status of [502,504]) {
  const seen=[], accepted=new Set();
  const provider={...cloud,authenticatedFetch:async(_p,init)=>{
   const headers=new Headers(init.headers),key=headers.get('idempotency-key');seen.push(headers);
   if(accepted.has(key))return new Response(JSON.stringify({error:{message:'REQUEST_ALREADY_EXISTS'}}),{status:409});
   accepted.add(key);
   if(seen.length===1)return new Response('<html>proxy lost the response</html>',{status});
   return sse();
  }};
  await assert.rejects(callModelProvider({provider,body:requestBody}),/REQUEST_ALREADY_EXISTS/);
  assert.equal(accepted.size,1);assert.equal(seen.length,2);
  assert.equal(seen[0].get('idempotency-key'),seen[1].get('idempotency-key'));
  assert.equal(seen[0].get('x-aporia-logical-request-id'),seen[1].get('x-aporia-logical-request-id'));
  assert.equal(seen[1].get('x-aporia-retry-of'),null);
 }
});
await test('heartbeat SSE rejection preserves retry delay and links only a released request',async()=>{
 const seen=[],events=[],parent='22222222-2222-4222-8222-222222222222';
 const payload={error:{message:'APORIA_MODEL_BUSY',type:'rate_limit_error'},status:429,requestId:parent,retryAfterMs:2000,
  request:{requestId:parent,usageState:'not-dispatched',billing:'released',chargedMicros:0}};
 const provider={...cloud,authenticatedFetch:async(_p,init)=>{
  seen.push(new Headers(init.headers));
  return seen.length===1?new Response(': aporia-waiting\n\nevent: aporia_error\ndata: '+JSON.stringify(payload)+'\n\n',
   {headers:{'content-type':'text/event-stream','x-aporia-request-id':parent}}):sse();
 }};
 await callModelProvider({provider,body:requestBody,onEvent:event=>events.push(event)});
 assert.equal(seen.length,2);assert.notEqual(seen[0].get('idempotency-key'),seen[1].get('idempotency-key'));
 assert.equal(seen[0].get('x-aporia-logical-request-id'),seen[1].get('x-aporia-logical-request-id'));
 assert.equal(seen[1].get('x-aporia-retry-of'),parent);
 assert(events.find(e=>e.type==='response.retry').delayMs>=2000);
});
await test('HTTP and SSE never regenerate pending, unsettled, settled or unconfirmed accounting',async()=>{
 const id='33333333-3333-4333-8333-333333333333';
 for(const streaming of [false,true]) for(const usageState of ['pending','unsettled','provider','dispatching']) {
  let calls=0;
  const payload={error:{message:'APORIA_PROVIDER_UNAVAILABLE'},status:503,requestId:id,
   request:{requestId:id,usageState,billing:usageState==='provider'?'settled':'unresolved',chargedMicros:usageState==='provider'?12:null}};
  const provider={...cloud,authenticatedFetch:async()=>{calls++;return streaming
   ?new Response(': aporia-waiting\n\nevent: aporia_error\ndata: '+JSON.stringify(payload)+'\n\n')
   :new Response(JSON.stringify(payload),{status:503,headers:{'x-aporia-request-id':id}});}};
  await assert.rejects(callModelProvider({provider,body:requestBody}),e=>!e.retryable&&e.cloudRequestId===id&&e.cloudUsageState===usageState);
  assert.equal(calls,1);
 }
 for(const extra of [{accountingPending:true},{request:{requestId:id,usageState:'not-dispatched',billing:'unresolved',chargedMicros:null}},
  {request:{requestId:'other',usageState:'not-dispatched',billing:'released',chargedMicros:0}}]) {
  let calls=0;
  const provider={...cloud,authenticatedFetch:async()=>{calls++;return new Response(JSON.stringify({
   error:{message:'APORIA_MODEL_BUSY'},requestId:id,...extra}),{status:429,headers:{'x-aporia-request-id':id}});}};
  await assert.rejects(callModelProvider({provider,body:requestBody}),e=>!e.retryable);assert.equal(calls,1);
 }
});

await mkdir('.tmp/audit-results',{recursive:true});await writeFile('.tmp/audit-results/cloud-compatibility.json',JSON.stringify({results},null,2));
await rm(temp,{recursive:true,force:true});console.log(`Cloud compatibility: ${results.filter(r=>r.passed).length}/${results.length}`);assert(results.every(r=>r.passed));

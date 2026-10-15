import assert from "node:assert/strict";
import { completeLoopRequest } from "../electron/runtime/loop-recovery.js";
import { callModelProvider } from "../electron/runtime/provider-stream.js";
import { withDurableRun } from "../electron/runtime/durable-run.js";
import { createRunControl } from "../electron/runtime/run-control.js";
import { createAporiaCloudProvider } from "../electron/provider-config.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveRunCheckpoint, saveRunContext, getRunRecoveryContext, beginRunJournal, closeRunJournalStore } from "../electron/run-store.js";

const cloud = createAporiaCloudProvider("https://model.fixture.invalid");
const body = {model:"aporia-cloud-default",messages:[{role:"user",content:"fixture"}]};
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sse = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
 {headers:{"x-aporia-request-id":id}});
const json = (v,status=200) => new Response(JSON.stringify(v),{status,headers:{"x-aporia-request-id":id}});
const copy = v => JSON.parse(JSON.stringify(v));
function context(extra={}) {
 const checkpoints={},contexts={},control=createRunControl({networkRetryMs:1});
 return {control, checkpoints, contexts, requestTrace:{taskId:"task-1",runId:"run-1"},
 checkpoint:async value=>{checkpoints[value.scopeId]=copy(value);},
 context:async(scope,value)=>{contexts[scope]=JSON.parse(value);}, ...extra};
}
function infer(provider,extra={}) {
 const fixtureProvider={...provider,authenticatedFetch:(path,init)=>path==="/v1/capabilities" && provider.fixtureLegacyGateway!==true
   ? Promise.resolve(json({protocolVersion:1,modelGateway:{idempotency:"reject-duplicate-no-replay"}})) : provider.authenticatedFetch(path,init)};
 return completeLoopRequest({conversation:body.messages,contextCheckpoints:[],accounting:{},getBody:()=>body,
 complete:(body,signal)=>callModelProvider({provider:fixtureProvider,body,signal,requestTrace:{agentId:extra.scopeId||"main"}}),...extra});
}
const results=[];
async function test(name,fn){try{await fn();results.push({name,passed:true});console.log("PASS",name);}catch(e){results.push({name,passed:false,error:String(e)});console.error("FAIL",name,e);}}
await test("outer network recovery keeps both IDs and deduplicates an accepted POST",async()=>{
 const c=context(),seen=[],accepted=new Set();
 const provider={...cloud,authenticatedFetch:async(_,init)=>{
  const h=new Headers(init.headers),key=h.get("idempotency-key");seen.push(h);
  assert.equal(c.checkpoints["cloud-request:main"].identity.clientRequestId,key);
  if(accepted.has(key))return json({error:{message:"REQUEST_ALREADY_EXISTS"}},409);
  accepted.add(key);throw new TypeError("fetch failed");
 }};
 await assert.rejects(withDurableRun(c,()=>infer(provider)),/REQUEST_ALREADY_EXISTS/);
 assert.equal(seen.length,2);assert.equal(accepted.size,1);
 assert.equal(seen[0].get("x-aporia-logical-request-id"),seen[1].get("x-aporia-logical-request-id"));
 assert.equal(seen[1].get("x-aporia-retry-of"),null);
});
await test("sleep before receiving headers keeps the original key on wake",async()=>{
 const c=context(),seen=[];
 const provider={...cloud,authenticatedFetch:async(_,init)=>{
  seen.push(new Headers(init.headers));if(seen.length>1)return sse();
  c.control.suspend();setTimeout(()=>c.control.wake(),5);
  throw Object.assign(new Error("aborted"),{name:"AbortError"});
 }};
 await withDurableRun(c,()=>infer(provider));
 assert.equal(seen.length,2);assert.equal(seen[0].get("idempotency-key"),seen[1].get("idempotency-key"));
});
await test("only a matching released no-dispatch receipt authorizes a new attempt",async()=>{
 const c=context(),posts=[];let gets=0;
 const provider={...cloud,authenticatedFetch:async(path,init)=>{
  if(init.method==="GET"){gets++;assert.equal(path,"/v1/requests/"+id);return json({requestId:id,usageState:"not-dispatched",billing:"released",chargedMicros:0});}
  posts.push(new Headers(init.headers));
  if(posts.length===1)return new Response(new ReadableStream({pull(controller){controller.error(new TypeError("terminated"));}}),{headers:{"x-aporia-request-id":id}});
  return sse();
 }};
 await withDurableRun(c,()=>infer(provider));
 assert.equal(gets,1);assert.equal(posts.length,2);
 assert.notEqual(posts[0].get("idempotency-key"),posts[1].get("idempotency-key"));
 assert.equal(posts[0].get("x-aporia-logical-request-id"),posts[1].get("x-aporia-logical-request-id"));
 assert.equal(posts[1].get("x-aporia-retry-of"),id);
});
await test("pending, settled, active or mismatched receipts cannot regenerate",async()=>{
 for(const usageState of ["pending","unsettled","provider","dispatching","not-dispatched"]){
  const c=context();let posts=0;
  const provider={...cloud,authenticatedFetch:async(_,init)=>{
   if(init.method==="GET")return json({requestId:usageState==="not-dispatched"?"other":id,usageState,billing:usageState==="provider"?"settled":"released",chargedMicros:0});
   posts++;return new Response("data: "+JSON.stringify({choices:[{delta:{content:"partial"}}]})+"\n\n",{headers:{"x-aporia-request-id":id}});
  }};
  await assert.rejects(withDurableRun(c,()=>infer(provider)),e=>e.code==="CLOUD_REQUEST_RECONCILIATION_REQUIRED");
  assert.equal(posts,1);
 }
});
await test("legacy dedup support or a missing known request fails closed instead of another POST",async()=>{
 for(const known of [false,true]){
  let posts=0;
  const provider={...cloud,fixtureLegacyGateway:true,authenticatedFetch:async(_,init)=>{
   if(init.method==="GET")return json({error:"not found"},404);
   posts++;if(!known)throw new TypeError("fetch failed");
   return new Response("data: {}\n\n",{headers:{"x-aporia-request-id":id}});
  }};
  await assert.rejects(withDurableRun(context(),()=>infer(provider)),e=>e.code==="CLOUD_REQUEST_RECONCILIATION_REQUIRED");
  assert.equal(posts,1);
 }
});
await test("independent Builders never share identities",async()=>{
 const c=context(),seen=new Map();
 const provider={...cloud,authenticatedFetch:async(_,init)=>{
  const h=new Headers(init.headers),agent=h.get("x-aporia-agent-id"),items=seen.get(agent)||[];
  items.push(h.get("idempotency-key"));seen.set(agent,items);
  if(items.length===1)throw new TypeError("fetch failed");return sse();
 }};
 await withDurableRun(c,()=>Promise.all(["builder-1","builder-2"].map(scopeId=>infer(provider,{scopeId}))));
 assert.equal(seen.size,2);
 for(const items of seen.values()){assert.equal(items.length,2);assert.equal(items[0],items[1]);}
 assert.notEqual(seen.get("builder-1")[0],seen.get("builder-2")[0]);
});
await test("durable request restoration preserves identity and rejects changed uncertain input",async()=>{
 const initial=context();const fatal=Object.assign(new Error("stopped"),{name:"AbortError"});
 await assert.rejects(withDurableRun(initial,()=>infer({...cloud,authenticatedFetch:async()=>{throw fatal;}})));
 const checkpoints=copy(initial.checkpoints),previous=checkpoints["cloud-request:main"].identity;
 const resumed=context({requestCheckpoints:copy(checkpoints)});let observed;
 await withDurableRun(resumed,()=>infer({...cloud,authenticatedFetch:async(_,init)=>{observed=new Headers(init.headers);return sse();}}));
 assert.equal(observed.get("idempotency-key"),previous.clientRequestId);
 assert.equal(observed.get("x-aporia-logical-request-id"),previous.logicalRequestId);
 let calls=0;
 await assert.rejects(withDurableRun(context({requestCheckpoints:copy(checkpoints)}),()=>infer({...cloud,authenticatedFetch:async()=>{calls++;return sse();}},
 {getBody:()=>({...body,messages:[{role:"user",content:"changed"}]})})),e=>e.code==="CLOUD_REQUEST_RECONCILIATION_REQUIRED");
 assert.equal(calls,0);
});
await test("complete response saved just before sleep is reused without double usage",async()=>{
 const c=context();let calls=0,failedUsage=0,slept=false;const save=c.context;
 c.context=async(scope,value)=>{await save(scope,value);if(!slept&&scope.startsWith("cloud-response:")){slept=true;c.control.suspend();setTimeout(()=>c.control.wake(),5);}};
 const result=await withDurableRun(c,()=>infer({...cloud,authenticatedFetch:async()=>{calls++;return sse();}},{onFailedUsage:()=>failedUsage++}));
 assert.equal(result.message.content,"ok");assert.equal(calls,1);assert.equal(failedUsage,0);
 const restored=context({requestCheckpoints:copy(c.checkpoints),recoveryContexts:copy(c.contexts)});
 const replay=await withDurableRun(restored,()=>infer({...cloud,authenticatedFetch:async()=>{calls++;return sse();}}));
 assert.equal(replay.message.content,"ok");assert.equal(calls,1);
 // New confirmed history is not confused with an old, already complete response.
 await withDurableRun(context({requestCheckpoints:copy(c.checkpoints),recoveryContexts:copy(c.contexts)}),()=>infer({...cloud,authenticatedFetch:async()=>{calls++;return sse();}},
 {getBody:()=>({...body,messages:[...body.messages,{role:"assistant",content:"ok"},{role:"user",content:"next"}]})}));
 assert.equal(calls,2);
});
await test("failure to durably save identity prevents any HTTP POST",async()=>{
 let calls=0;const c=context({checkpoint:async()=>{throw new Error("disk unavailable");}});
 await assert.rejects(withDurableRun(c,()=>infer({...cloud,authenticatedFetch:async()=>{calls++;return sse();}})),/disk unavailable/);
 assert.equal(calls,0);
});
await test("sequential logical inferences use different keys, even with identical bodies",async()=>{
 const c=context(),keys=[];const provider={...cloud,authenticatedFetch:async(_,init)=>{keys.push(new Headers(init.headers).get("idempotency-key"));return sse();}};
 await withDurableRun(c,async()=>{await infer(provider);await infer(provider);});
 assert.notEqual(keys[0],keys[1]);
});
await test("BYOK recovery keeps prior behavior and does not save Cloud identity",async()=>{
 const c=context();let calls=0;
 const result=await withDurableRun(c,()=>completeLoopRequest({conversation:[],getBody:()=>body,complete:async()=>{if(++calls===1)throw new TypeError("fetch failed");return {message:{content:"ok"}};}}));
 assert.equal(result.message.content,"ok");assert.equal(calls,2);assert(!c.checkpoints["cloud-request:main"]);
});
await test("SQLite journal survives reopen with request IDs and confirmed response intact",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"aporia-cloud-identity-")),runId="identity-fixture";let calls=0;
 try {
  await beginRunJournal(dir,{runId,taskId:"task-1"});
  const c=context({checkpoint:value=>saveRunCheckpoint(dir,runId,value),context:(scope,value)=>saveRunContext(dir,runId,scope,value)});
  const provider={...cloud,authenticatedFetch:async()=>{calls++;return sse();}};
  await withDurableRun(c,()=>infer(provider));await closeRunJournalStore(dir);
  const recovered=await getRunRecoveryContext(dir,runId);
  const result=await withDurableRun(context({requestCheckpoints:recovered.checkpoint.agents,recoveryContexts:recovered.contexts}),()=>infer(provider));
  assert.equal(result.message.content,"ok");assert.equal(calls,1);
 } finally {await closeRunJournalStore(dir);await rm(dir,{recursive:true,force:true});}
});
await mkdir(".tmp/audit-results",{recursive:true});
await writeFile(".tmp/audit-results/cloud-outer-recovery.json",JSON.stringify({results},null,2));
assert(results.every(r=>r.passed));console.log("Cloud outer recovery:",results.length,"passed");

import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {runHarness} from "../electron/agent-runtime.js";
import {waitForWorkers} from "../electron/runtime/collect-workers.js";
import {createKernelAgentRuntimeBroker,setDefaultAgentRuntimeBroker,clearDefaultAgentRuntimeBroker} from "../electron/harness/agent-runtime-broker.js";
import {createAgentDefinitionRegistry} from "../electron/harness/agent-definitions.js";
import {HarnessSessionStore} from "../electron/harness/session.js";
import {HarnessScheduler} from "../electron/harness/scheduler.js";

const fast={status:"completed",promise:Promise.resolve({})};
const slow={status:"running",promise:new Promise(()=>{})};
await waitForWorkers([slow,fast],{mode:"any",timeoutMs:30000});
await waitForWorkers([slow],{mode:"all",timeoutMs:1});
const aborted=new AbortController();aborted.abort();
await assert.rejects(()=>waitForWorkers([slow],{signal:aborted.signal}),{name:"AbortError"});
const root=await mkdtemp(join(tmpdir(),"aporia-worker-continuation-"));
const originalFetch=globalThis.fetch;
const controller=new AbortController();
const timer=setTimeout(()=>controller.abort(),12000);
const sse=delta=>new Response(`data: ${JSON.stringify({choices:[{delta}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})}\n\ndata: [DONE]\n\n`);
const call=(id,name,input)=>sse({tool_calls:[{index:0,id,type:"function",function:{name,arguments:JSON.stringify(input)}}]});
let main=0,worker=0,continued=false;
const events=[];
const kernel={agents:createAgentDefinitionRegistry(),sessions:new HarnessSessionStore(),scheduler:new HarnessScheduler({concurrency:2})};
setDefaultAgentRuntimeBroker(createKernelAgentRuntimeBroker({kernel}));
try {
  await writeFile(join(root,"a.txt"),"retained file evidence");
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);
    const text=body.messages.map(m=>m.content||"").join("\n");
    assert(body.messages.every(m=>!Object.keys(m).some(k=>k.startsWith("aporia"))));
    if(text.includes("You are the AporiaX explore subagent.")){
      worker++;
      if(text.includes("Follow-up B")){
        assert(text.includes("Original A"));assert(text.includes("retained file evidence"));continued=true;
        return sse({content:"Worker B complete."});
      }
      if(worker===1)return call("read","read_file",{path:"a.txt"});
      return sse({content:"Worker A complete."});
    }
    main++;
    if(main===1)return call("spawn","delegate_subagent",{role:"explore",task:"Original A: inspect a.txt",scope:["a.txt"],background:true});
    if(main===2)return call("collect-a","collect_subagents",{wait:true});
    if(main===3)return call("follow","followup_subagent",{agent_id:"continuation-sub-1",task:"Follow-up B: explain the evidence already read."});
    if(main===4)return call("collect-b","collect_subagents",{wait:true});
    assert(continued);return sse({content:"Both parts complete."});
  };
  const result=await runHarness({runId:"continuation",taskId:"fixture",workspacePath:root,provider:{id:"fake",name:"fake",vendor:"openai",baseUrl:"https://test.invalid/v1",apiKey:"fake",models:[{id:"test",supportsTools:true,contextWindow:32000}]},modelId:"test",permission:"read-only",approvalMode:"manual",language:"en",signal:controller.signal,messages:[{role:"user",content:"Explore the file and follow up."}],agentBudget:{profile:"read",maxTotalSubagents:1,maxActiveSubagents:1},onEvent:e=>events.push(e)});
  assert.equal(result.status,"completed");assert(continued);assert.equal(worker,3);
  assert(!events.some(e=>e.type==="agent_budget.denied"));
  assert.equal(kernel.sessions.get("continuation-sub-1").metadata.continuations,1);
  assert.equal(result.subagents.length,1);
} finally {clearTimeout(timer);globalThis.fetch=originalFetch;clearDefaultAgentRuntimeBroker();await rm(root,{recursive:true,force:true});}
console.log("Worker continuation through Kernel, retained context, bounded collect-any and reused budget slot: PASS");

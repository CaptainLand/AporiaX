import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compactConversationForRequest } from "../electron/agent-context-core.js";
import { upsertRelevantContextMessage } from "../electron/agent-context.js";
import { taskRequest, harnessFeedback, providerMessages } from "../electron/runtime/task-conversation.js";
import { planAgentBudget, runWithAgentBudget, enforceAgentBudgetEvent, currentAgentBudget } from "../electron/harness/agent-budget.js";
import { assertSubagentScope, assertSubagentRealScope } from "../electron/runtime/subagent-model.js";
import { runSubagentTask } from "../electron/runtime/subagent-loop.js";
import { ToolRegistry } from "../electron/agent-core.js";
import { TurnCoordinator } from "../electron/runtime/turn-coordinator.js";
import { createWitnessMonitor } from "../electron/witness-monitor.js";

const request = taskRequest({role:"user",content:"A".repeat(1500)+" MUST_NOT_UPLOAD"});
const restoreNotice = {
  role: "user",
  kind: "anchor-restore",
  aporiaSource: "harness",
  aporiaPinned: true,
  content: "AporiaX workspace restore notice:\nThe user restored workspace files.",
};
const history = [{role:"system",content:"Stable instructions"},request,restoreNotice];
for (let i=0;i<30;i++) history.push({role:"assistant",content:"old evidence "+i+"中".repeat(3000)});
history.push(taskRequest({role:"user",content:"Keep the original artifact."}));
history.push(harnessFeedback("Internal review completed; integrate findings."));
const checkpoints=[];
compactConversationForRequest({conversation:history,contextCheckpoints:checkpoints,contextWindowTokens:32000});
assert(history.some(m=>m.content===request.content));
assert(history.some(m=>m.content==="Keep the original artifact."));
assert(history.some(m=>String(m.content||"").startsWith("AporiaX workspace restore notice:")));
assert(!checkpoints.at(-1).requirements.some(s=>s.includes("Internal review")));
assert(!checkpoints.at(-1).requirements.some(s=>s.includes("workspace restore notice")));
assert(providerMessages(history).every(m=>!Object.keys(m).some(k=>k.startsWith("aporia"))));
const retrieval=[{role:"system",content:"stable"},{role:"user",content:"ALPHA"}];
assert.equal(upsertRelevantContextMessage(retrieval).length,0);
retrieval.push({role:"user",content:"BETA"});
const facts=[{content:"BETA durable fact"}];
assert.equal(upsertRelevantContextMessage(retrieval,{memoryFacts:facts}).length,1);
const after=JSON.stringify(retrieval);
upsertRelevantContextMessage(retrieval,{memoryFacts:facts});
assert.equal(JSON.stringify(retrieval),after);
assert.equal(retrieval[0].content,"stable");

await runWithAgentBudget(planAgentBudget({agentBudget:{profile:"direct",maxTotalSubagents:0,maxActiveSubagents:0}}),{},async()=>{
  enforceAgentBudgetEvent({type:"plan.updated",plan:{steps:Array(7).fill({title:"step"})}});
  assert.equal(currentAgentBudget().limits.maxTotalSubagents,0);
  assert.equal(currentAgentBudget().limits.maxActiveSubagents,0);
  assert.throws(()=>enforceAgentBudgetEvent({type:"subagent.started",agentId:"forbidden",role:"explore"}),/budget/i);
});
assert.throws(()=>assertSubagentScope("read_file",{path:"src/../private.txt"},["src"]),/outside/);
assert.throws(()=>assertSubagentScope("read_file",{path:"../../private.txt"},["."]),/outside/);
assert.throws(()=>new TurnCoordinator().observeModelResponse({content:" "}),/MODEL_EMPTY_RESPONSE/);
let time=Date.now();
const witness=createWitnessMonitor({now:()=>time,heartbeatMs:0,emit:()=>{}});
witness.observe({type:"turn.started"});witness.observe({type:"response.reset",round:1});
for(let i=0;i<13;i++){time+=10000;witness.observe({type:"response.delta",delta:"visible output"});}
witness.heartbeat();assert(!witness.snapshot().alerts.some(a=>a.code.startsWith("stalled:")));
time+=121000;witness.heartbeat();assert(witness.snapshot().alerts.some(a=>a.code.startsWith("stalled:")));
witness.observe({type:"response.activity"});assert(!witness.snapshot().alerts.some(a=>a.code.startsWith("stalled:")));witness.dispose();

const root=await mkdtemp(join(tmpdir(),"aporia-long-task-"));
try {
  await mkdir(join(root,"src"));await mkdir(join(root,"private"));
  await writeFile(join(root,"private","secret.txt"),"test fixture, not a secret");
  await symlink(join(root,"private"),join(root,"src","linked"),process.platform==="win32"?"junction":"dir");
  await assert.rejects(()=>assertSubagentRealScope("read_file",{path:"src/linked/secret.txt"},["src"],root),/outside/);
  await assertSubagentRealScope("read_file",{path:"src/missing.txt"},["src"],root);
  const toolRegistry=new ToolRegistry([{risk:"read",definition:{type:"function",function:{name:"read_file",parameters:{type:"object",properties:{path:{type:"string"}}}}}}]);
  let executions=0, rounds=0, seenModel, protocolRetained=false;
  const provider={id:"fake",supportsTools:true,complete:async({body})=>{
    seenModel=body.model;
    if(++rounds===1) return {message:{content:null,reasoning_content:"synthetic protocol state",tool_calls:[{id:"read",type:"function",function:{name:"read_file",arguments:'{"path":"src/missing.txt"}'}}]}};
    protocolRetained=body.messages.some(m=>m.reasoning_content==="synthetic protocol state");
    return {message:{content:"Finished mocked check."}};
  }};
  const result=await runSubagentTask({__kernelRouted:true,agentId:"test",input:{role:"review",task:"test",scope:["src"],maxRounds:4},provider,modelId:"parent",modelConfig:{contextWindow:32000},workspaceRoot:root,parentPermissionPolicy:{"*":"allow"},approvalMode:"manual",requestApproval:async()=>({approved:false}),signal:new AbortController().signal,language:"en",memoryFacts:[],emit:()=>{},toolRegistry,agentDefinition:{model:"configured",tools:["read_file"],permissions:{read_file:"deny"},maxRounds:4},resolveModel:async id=>({provider,modelId:id,modelConfig:{contextWindow:32000}}),parseToolArguments:call=>JSON.parse(call.function.arguments),executeAuthorizedTool:async()=>{executions++;return{modelResult:{content:"mock"}};}});
  assert.equal(seenModel,"configured");assert.equal(executions,0);assert(protocolRetained);assert.equal(result.status,"completed");
} finally { await rm(root,{recursive:true,force:true}); }
console.log("Long-task reliability: pinned human requests, fresh retrieval, hard budgets, real scope, effective model/permissions, protocol and live heartbeat: PASS");

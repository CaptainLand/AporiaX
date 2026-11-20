import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {gzipSync} from 'node:zlib';
import {captureContext,thawContext,contextMemo,encodeContext,decodeContext,initializeChunkSchema} from '../electron/context-chunks.js';
import {TaskBrief} from '../electron/runtime/task-brief.js';
import {estimateConversationTokens} from '../electron/agent-context-core.js';
import {reviewWorkerResult} from '../electron/runtime/subagent-contract.js';
import {acceptedDependencyReady} from '../electron/runtime/role-coordinator.js';
import {saveCloudCandidate,restoreCloudCandidate} from '../electron/runtime/cloud-request-identity.js';

const input={report_id:'r',decision:'accepted',reason:'Check score',evidence_ids:['main:1']};
const worker={status:'partial',role:'verify',collected:true,input:{verificationCheck:{command:'node score-test.js',cwd:'.'}},result:{reportId:'r',evidence:[]}};
const evidence=new Map([['main:1',{tool:'read_file',path:'README.md'}]]);
assert.throws(()=>reviewWorkerResult(worker,input,evidence),/REFERENCE_ONLY/);
worker.result.acceptance=reviewWorkerResult(worker,{...input,reference_only:true},evidence);
assert(acceptedDependencyReady(worker,'report'));assert(!acceptedDependencyReady(worker,'changes'));
evidence.set('main:1',{tool:'run_command',exitCode:0,command:'node score-test.js',cwd:'.',observedVersion:'v1'});
worker.result.acceptance=reviewWorkerResult(worker,input,evidence);
assert(acceptedDependencyReady(worker,'verified','v1'));assert(!acceptedDependencyReady(worker,'verified','v2'));
const identity={identity:{serverRequestId:'r'},scopeId:'fixture'};
const receipt={requestId:'r',billing:'settled',status:'completed',usageState:'provider',finishReason:'tool_calls'};
await saveCloudCandidate(identity,'r',{tool_calls:[{id:'t',function:{name:'x',arguments:'{'}}]},'tool_calls');
assert.equal(await restoreCloudCandidate(identity,receipt),null);
await saveCloudCandidate(identity,'r',{content:'answer'},'stop');
for(const r of [receipt,{...receipt,finishReason:'stop',requestId:'different'},{...receipt,finishReason:'stop',billing:'unresolved'}])
  assert.equal(await restoreCloudCandidate(identity,r),null);
const db=new DatabaseSync(':memory:');initializeChunkSchema(db);
const state={plan:0,literal:'\0ax:0',conversation:Array.from({length:512},(_,i)=>({role:'tool',content:String(i).padEnd(8192,'x')}))};
const capture=captureContext(state);state.plan=1;assert.equal(thawContext(capture).plan,0);
const times=[[],[]];let manifest;
for(let round=0;round<16;round++) for(const mode of round%2?[1,0]:[0,1]){
  state.plan++;const start=performance.now();
  const snapshot=mode?thawContext(captureContext(state)):JSON.parse(JSON.stringify(state));
  db.exec('BEGIN IMMEDIATE');const memo=mode?contextMemo(db):undefined;
  manifest=encodeContext(db,snapshot,memo);gzipSync(manifest,{level:1});db.exec('COMMIT');memo?.commit();
  if(round>=3)times[mode].push(performance.now()-start);
}
assert.deepEqual(decodeContext(db,manifest),state);db.close();
console.log('4 MiB checkpoint CPU path, paired medians ms (old,new):',times.map(t=>+t.sort((a,b)=>a-b)[6].toFixed(2)));
const brief=new TaskBrief(); const messages=Array.from({length:16},(_,i)=>({role:'user',id:'user-'+i,content:'Constraint '+i}));
brief.syncSources(messages);
for(let i=0;i<8;i++){const callId='read-'+i;brief.observe({callId,tool:'read_file',input:{path:'a'+i},result:{path:'a'+i,sha256:'a'.repeat(64)},version:'v1'});
  brief.apply({action:'record',kind:'decision',expected_revision:i,summary:'Use file '+i,rationale:'Observed in workspace',evidence_call_ids:[callId]});}
const conversation=[];brief.inject(conversation,{version:'v1'});const msg=conversation[0],split=msg.content.indexOf('\n');
const compact=JSON.parse(msg.content.slice(split+1)),view=brief.view('v1');
const legacy=msg.content.slice(0,split+1)+JSON.stringify({...compact,entries:view.entries,sourceIds:view.sources.map(({id,hash})=>({id,hash}))});
assert.deepEqual(compact.sourceIds,messages.map(m=>m.id));assert.equal(compact.entries.length,8);assert(view.entries[0].evidence[0].resultHash);
console.log('Brief UTF-8 bytes and harness-estimated tokens (old,new):',[legacy,msg.content].map(content=>[Buffer.byteLength(content),estimateConversationTokens([{...msg,content}])]));
console.log('PASS checkpoint restore, reference-only vs verified edges, candidate guards, brief provenance');

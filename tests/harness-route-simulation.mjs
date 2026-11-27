// Local fixture only; launched by Cloud's disposable-db compatibility suite.
import assert from 'node:assert/strict';
import {callModelProvider} from '../electron/runtime/provider-stream.js';
import {createLoopRequestIdentity,withLoopRequestIdentity} from '../electron/runtime/cloud-request-identity.js';
import {withDurableRun} from '../electron/runtime/durable-run.js';
export async function simulate({direct,base,headers,model,callCount,reverse=false}) {
  assert.equal(new URL(base).hostname,'127.0.0.1'); assert.equal(new URL(direct).hostname,'127.0.0.1');
  const rows=[];
  const routes=['local','cloud','cloud-lost-DONE','cloud-opt-in-replay','cloud-opt-in-auto'];
  for (const route of reverse?routes.reverse():routes) {
    let gets=0, tools=0, input=0, output=0, dropped=false;
    const requestIds=[], before=callCount(), start=performance.now();
    const provider={kind:route==='local'?'openai-compatible':'aporia-cloud',id:route,baseUrl:direct,name:route,apiKey:'fixture',
      authenticatedFetch:async(path,init)=>{
        const h=new Headers(init.headers);h.set('authorization',headers.authorization);
        if(route==='cloud-opt-in-replay' && init.method==='POST')h.set('x-aporia-output-window','memory-120s');
        const res=await fetch(base+path,{...init,headers:h});
        if (init.method==='GET') { gets++; return res; }
        requestIds.push(res.headers.get('x-aporia-request-id'));
        if (!['cloud-lost-DONE','cloud-opt-in-replay','cloud-opt-in-auto'].includes(route)||dropped||!res.ok) return res;
        dropped=true;
        // The real gateway settled; the transport proxy loses billing + DONE.
        const bytes=await res.text();
        assert(bytes.includes('event: aporia_billing') && bytes.includes('[DONE]'));
        return new Response(route.startsWith('cloud-opt-in')?'':bytes.split('event: aporia_billing')[0],{headers:res.headers});
      }};
    const messages=[{role:'user',content:'route-simulation'}];
    const body=()=>({model,messages,tools:[{type:'function',function:{name:'get_total',parameters:{type:'object',properties:{a:{type:'number'},b:{type:'number'}}}}}],max_completion_tokens:64,stream:true});
    const response=async id=>withLoopRequestIdentity(createLoopRequestIdentity(id),async()=>{
      const execute=()=>callModelProvider({provider,body:body(),maxAttempts:1});
      let r;
      if (id==='one' && route==='cloud-opt-in-replay') {
        await assert.rejects(execute,/INCOMPLETE/); r=await execute();
      } else r=await execute();
      input+=r.usage.prompt_tokens;output+=r.usage.completion_tokens;
      return r.message;
    });
    const previous=process.env.APORIA_CLOUD_OUTPUT_WINDOW;
    if(route==='cloud-opt-in-auto') process.env.APORIA_CLOUD_OUTPUT_WINDOW='memory-120s'; else delete process.env.APORIA_CLOUD_OUTPUT_WINDOW;
    try {await withDurableRun({context:async()=>{},checkpoint:async()=>{}},async()=>{
      const m=await response('one'), call=m.tool_calls?.[0];
      assert.equal(call?.function.name,'get_total');
      const {a,b}=JSON.parse(call.function.arguments);tools++;
      messages.push({role:'assistant',...m},{role:'tool',tool_call_id:call.id,content:String(a+b)});
      assert.equal((await response('two')).content,'ok');
    });} finally {if (previous===undefined) delete process.env.APORIA_CLOUD_OUTPUT_WINDOW; else process.env.APORIA_CLOUD_OUTPUT_WINDOW=previous;}
    assert.equal(tools,1);assert.equal(callCount()-before,2);assert.equal(gets,route==='cloud-opt-in-replay'?2:['cloud-lost-DONE','cloud-opt-in-auto'].includes(route)?1:0);
    rows.push({route,ms:Math.round(performance.now()-start),calls:callCount()-before,tools,gets,input,output,requestIds});
  }
  return rows;
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rmdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarness } from '../electron/agent-runtime-core.js';
import { createRunControl } from '../electron/runtime/run-control.js';
import { estimateConversationTokens } from '../electron/agent-context.js';
import { captureDelegationContext, readDelegationContext, syncDelegationContext } from '../electron/runtime/subagent-contract.js';

const q = '2 加 2 等于几？直接回答。';
const message = content => ({role:'user',content});
const names = body => body.tools.map(d=>d.function.name);
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const instructions = body => body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
const ask = (id,name,args) => ({tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
test('Agent chooses whether to fetch scoped tools and history, with no classifier request', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'aporia-wire-budget-')));
  const original = globalThis.fetch;
  const history = [
    message('不要修改或发布。'),
    message('原来的两个方案是什么？'),
    {role:'assistant',content:'第一种：保留现状。第二种：检查 note.txt。详细说明：'+'irrelevant explanation. '.repeat(170)},
    message('之后哪个文件要核对？'),
    {role:'assistant',content:'待定。'},
  ];
  async function run(content,reply,options={}) {
    const bodies=[], errors=[];
    const signal=AbortSignal.timeout(8000);
    globalThis.fetch=async (_,init)=>{
      const body=JSON.parse(init.body); bodies.push(body);
      let delta;
      try { delta=reply(bodies.length,body); }
      catch (error) { errors.push(error); delta={content:'mock assertion failed'}; }
      const result={choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]};
      return new Response('data: '+JSON.stringify(result)+'\n\ndata: [DONE]\n\n');
    };
    const result=await runHarness({runId:'fixture-wire',workspacePath:root,modelId:'test',permission:'read-only',signal,
      provider:{id:'fixture',name:'fixture',baseUrl:'https://fixture.invalid/v1',apiKey:'fixture',models:[{id:'test',supportsTools:true,contextWindow:1000000}]},
      messages:[...history,message(content)],...options});
    if(errors.length)throw errors[0];
    assert.equal(result.status,'completed',result.content);
    return bodies;
  }
  const baselineNames=['enable_task_tools','read_conversation_history'];
  try {
    const [greeting]=await run('你好',()=>({content:'你好！'}),{messages:[message('你好')]});
    const estimate=estimateConversationTokens([...greeting.messages,{role:'system',content:JSON.stringify(greeting.tools)}]);
    assert(estimate<2000, 'simple first request should have low estimated overhead');
    console.log('Adaptive cold greeting: '+bytes(greeting)+' request bytes, '+estimate+' estimated input tokens.');
    for (const q of ['你好','计算123456*654321','计算114514*1919810']) {
      const requests=await run(q,()=>({content:'Example'}));
      assert.equal(requests.length,1);
      const [body]=requests;
      assert.deepEqual(names(body),baselineNames);
      assert(body.messages.some(m=>m.content==='不要修改或发布。'));
      assert(!body.messages.some(m=>m.content===history[2].content));
      assert.doesNotMatch(instructions(body),/Configured professional roles|Office artifact tools|Use native Git tools/);
      assert(bytes(body)<6000);
    }
    const [withAttachment]=await run('看这份附件。',()=>({content:'Attachment seen.'}),{messages:[
      {...message('看这份附件。'),attachments:[{kind:'document',name:'fixture.txt',content:'CURRENT_ATTACHMENT',format:'text'}]},
    ]});
    assert(withAttachment.messages.some(m=>m.role==='user'&&m.content.includes('CURRENT_ATTACHMENT')));
    const oldImage='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3n0AAAAASUVORK5CYII=';
    const currentImage='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const vision={id:'fixture',name:'fixture',baseUrl:'https://fixture.invalid/v1',apiKey:'fixture',
      models:[{id:'test',supportsTools:true,supportsImages:true,contextWindow:1000000}]};
    const oldOrdinary='旧日天气怎样？', boundary='只允许改 src/，不要发布。';
    const images=body=>body.messages.flatMap(m=>Array.isArray(m.content) ? m.content.filter(p=>p.type==='image_url').map(p=>p.image_url.url):[]);
    const attached=await run('对比这两张图。',(i,b)=>{
      assert(b.messages.some(m=>m.content===boundary));
      assert(!b.messages.some(m=>m.role==='user'&&m.content===oldOrdinary));
      if(i===1) {
        assert.deepEqual(images(b),[currentImage]);
        assert(b.messages.some(m=>typeof m.content==='string'&&m.content.includes('1 image(s)')));
        return ask('old-image','enable_task_tools',{history:{message_index:1,image_index:0}});
      }
      if(i===2) {
        assert.deepEqual(images(b),[currentImage,oldImage]);
        assert(!b.messages.find(m=>m.tool_call_id==='old-image').content.includes('base64'));
        return ask('old-text','read_conversation_history',{message_index:2});
      }
      assert.deepEqual(images(b),[currentImage]);
      assert.equal(JSON.parse(b.messages.find(m=>m.tool_call_id==='old-text').content).text,oldOrdinary);
      return {content:'Compared the available images.'};
    }, {provider:vision,messages:[
      message(boundary),{...message('这是旧的截图。'),attachments:[{kind:'image',dataUrl:oldImage}]},
      message(oldOrdinary),{...message('对比这两张图。'),attachments:[{kind:'image',dataUrl:currentImage}]},
    ]});
    assert.equal(attached.length,3);
    const file=join(root,'note.txt');
    await writeFile(file,'ACTUAL NOTE CONTENT');
    try {
      const bodies=await run('按第二个方案核对。',(i,b)=>{
        if(i===1) {
          assert.deepEqual(names(b),baselineNames);
          assert(!names(b).some(n=>n==='read_file'));
          const discover=b.tools.find(t=>t.function.name==='enable_task_tools');
          assert(!discover.function.parameters.properties.groups.items.enum.includes('workspace_write'));
          return ask('discover','enable_task_tools',{groups:['workspace_read'],history:{message_index:2}});
        }
        assert(names(b).includes('read_file'));
        assert(!names(b).some(n=>['write_file','git_status','delegate_subagent'].includes(n)));
        assert.match(instructions(b),/FILE_ACCESS_DENIED/);
        const discovery=JSON.parse(b.messages.find(m=>m.tool_call_id==='discover').content);
        assert.equal(discovery.history.text,history[2].content);
        if(i===2) return ask('read','read_file',{path:'note.txt'});
        assert(b.messages.some(m=>m.tool_call_id==='read'&&m.content.includes('ACTUAL NOTE CONTENT')));
        return {content:'Inspected the selected file.'};
      });
      assert.equal(bodies.length,3);
      assert(bodies.every(b=>b.messages[0].content===bodies[0].messages[0].content));
      assert.deepEqual(names(bodies[1]),names(bodies[2]));
      console.log('Adaptive input UTF-8 bytes: initial / combined history & tools / execution evidence:',
        bodies.map(bytes).join(' / '));
    } finally { await unlink(file); }
    const denied=await run('Do this only when permitted.',(i,b)=>{
      if(i===1)return ask('denied','enable_task_tools',{groups:['workspace_write']});
      assert.deepEqual(names(b),baselineNames);
      assert.match(b.messages.find(m=>m.tool_call_id==='denied').content,/not available/);
      return {content:'Writes unavailable.'};
    });
    assert.equal(denied.length,2);
    const control=createRunControl();
    const steered=await run(q,(i,b)=>{
      assert.deepEqual(names(b),baselineNames);
      if(i===1) control.enqueueSteering(message('先别改动，解释一下第二种。'));
      else assert(b.messages.some(m=>m.content==='先别改动，解释一下第二种。'));
      return {content:'Example'};
    },{control});
    assert.equal(steered.length,2);
  } finally { globalThis.fetch=original; await rmdir(root); }
});

test('one-million-token worker: related context and constraints are visible, unrelated history is pageable but not sent', () => {
  const history=Array.from({length:40},(_,i)=>message('任务记录'+i+'：'+'这里是旧需求的背景说明，保留精确约束。'.repeat(45)));
  history.push(message('结算按钮的测试使用蓝色标签。不要发布。'),message('今天只检查结算按钮。'));
  const ctx=captureDelegationContext(history), convo=[{role:'system',content:'worker'}];
  syncDelegationContext(convo,ctx,{contextWindowTokens:1000000,assignment:'检查结算按钮'});
  const wire=convo[1].content;
  assert(wire.includes('蓝色标签')); assert(wire.includes('不要发布')); assert(wire.includes(history.at(-1).content));
  assert(wire.length < JSON.stringify(ctx).length/5); assert(!wire.includes('任务记录38'));
  const manifest=readDelegationContext(ctx); assert.equal(manifest.requests.length,history.length);
  for(const [i,r] of manifest.requests.entries()) {
    let text='',offset=0;
    do {const page=readDelegationContext(ctx,{revision:ctx.revision,request_id:r.id,offset,max_chars:237}); text+=page.content; offset=page.nextOffset;}while(offset!==null);
    assert.equal(text,history[i].content);
  }
  console.log('worker inherited history (full archive → wire projection):',JSON.stringify(ctx).length,'→',wire.length,'characters');
});

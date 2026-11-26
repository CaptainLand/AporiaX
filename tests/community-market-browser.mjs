import assert from 'node:assert/strict';
import { preview } from 'vite';
import { chromium } from 'playwright-core';

const server=await preview({preview:{host:'127.0.0.1',port:0,open:false}});
let browser;
try {
  const url=server.resolvedUrls.local[0];
  browser=await chromium.launch({executablePath:process.env.TEST_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1040,height:740}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.request().url().startsWith(url)?route.continue():route.abort());
  await page.addInitScript(()=>{
    localStorage.setItem('aporiax.language.v1','zh-CN');
    localStorage.setItem('aporiax.session-ui.v1',JSON.stringify({welcomeDismissed:true,taskId:'fixture'}));
    const signed={status:'authenticated',profile:{id:'owner',displayName:'Fixture'}};
    const entries=[['skill','常用 Skill',30],['skin','深蓝皮肤',80],['agent','阅读助手',12],['mcp','工具 MCP',20],['skin','只展示皮肤',null]];
    window.fixture={listCount:0,rules:false,open:0,adds:[],signed:false,legacy:false,remaining:1,submissions:[],duplicate:false,
      visibility:'published',mineActions:[]};
    const quota=()=>({limit:3,remaining:window.fixture.remaining,resetsAt:'2026-11-29T16:00:00.000Z'});
    window.desktop={
      account:{get:async()=>window.fixture.signed?signed:{status:'anonymous'},
        signIn:async()=>{window.fixture.signed=true;return signed;},refresh:async()=>signed},
      tasks:{load:async()=>[{id:'fixture',title:'市场测试',workspaceName:'测试',workspacePath:'D:/Fixture',messages:[]}],save:async()=>{}},
      providers:{list:async()=>[]}, harness:{onEvent:()=>()=>{},recoverableRuns:async()=>[],activeRuns:async()=>[]},
      workbench:{subscribe:()=>()=>{},request:async({action})=>action==='list'?[]:true},
      communityMarket:{
        list:async owner=>{window.fixture.listCount++;if(owner!=='owner')throw Error('owner');
          return {quota:quota(),rulesAccepted:window.fixture.rules,items:entries.map(([kind,title,downloadCount],i)=>({
            id:String(i),kind,title,downloadCount:window.fixture.legacy?null:downloadCount,author:'社区成员',
            publishedAt:new Date(Date.UTC(2026,0,i+1)).toISOString(),summary:i===1?'基础配色快照':'用于验证市场卡片、下载排序和分类筛选。',
            revision:1,sha256:i===1?'63ab9eb49fd9045a467fd2fb671b2a22708438bb9cca0a7ad42bce0cff7ab6f2':'a'.repeat(64),downloadAllowed:i!==4,added:false
          })).filter(row=>row.id!=='1'||window.fixture.visibility==='published')};},
        openCommunity:async()=>{window.fixture.open++;},
        uploadOptions:async()=>({quota:quota(),items:[{id:'skill:mine',kind:'skill',title:'我写的 Skill'}]}),
        uploadPreview:async({id})=>({id,title:'我写的 Skill',summary:'一段介绍',fileName:'SKILL.md',content:'Plain text',fingerprint:'f'.repeat(64),
          duplicate:window.fixture.duplicate}),
        mine:async()=>({items:[{id:'1',kind:'skin',title:'深蓝皮肤',revision:2,status:'approved',
          publication:{revision:1,visibility:window.fixture.visibility}},
          {id:'pending',kind:'skill',title:'待审核 Skill',revision:1,status:window.fixture.withdrawn?'withdrawn':'pending'}],hasMore:false}),
        manage:async input=>{
          window.fixture.mineActions.push(input);
          if(input.action==='unpublish')window.fixture.visibility='author_hidden';
          else window.fixture.withdrawn=true;
          return {changed:true};
        },
        submit:async input=>{
          window.fixture.submissions.push(input);
          if(window.fixture.submissions.length===1){window.fixture.remaining=0;throw Error('COMMUNITY_MARKET_UNAVAILABLE');}
          return {status:'pending',quota:quota()};
        },
        add:async input=>{window.fixture.adds.push(input);return {saved:true,downloadCount:81,localMatch:input.kind==='skill'};}
      },
    };
  });
  await page.goto(url);
  await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();
  if(await page.locator('.ax-welcome__enter').isVisible())await page.locator('.ax-welcome__enter').click();
  await page.getByRole('button',{name:'打开 AporiaX 设置'}).click();
  const nav=page.getByRole('navigation',{name:'设置分类'});
  assert.equal(await nav.locator('button:has-text("权限与审批") + button').innerText(),'社区插件市场');
  await nav.getByRole('button',{name:'社区插件市场'}).click();
  assert.equal(await page.evaluate(()=>window.fixture.listCount),0);
  await page.getByRole('button',{name:'登录 Aporia 账号'}).click();
  const cards=page.locator('.community-market-card');
  await cards.first().waitFor();
  assert.deepEqual(await cards.locator('h4').allTextContents(),['深蓝皮肤','常用 Skill','工具 MCP','阅读助手','只展示皮肤']);
  await page.getByText('深蓝黑底搭配明亮的橙色点缀',{exact:false}).waitFor();
  assert.equal(await cards.first().locator('.community-market-author').innerText(),'社区成员');
  assert(!((await cards.first().innerText()).includes('基础配色快照')));
  assert.equal(await page.getByRole('button',{name:'添加到本机'}).first().isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'上传插件'}).isDisabled(),true);
  await page.getByRole('button',{name:'打开网页社区'}).click();
  await page.waitForFunction(()=>window.fixture.open===1);
  await page.evaluate(()=>window.fixture.rules=true);
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  const filters=page.getByRole('group',{name:'资源类别'});
  await filters.getByRole('button',{name:'皮肤',exact:true}).click();
  assert.equal(await cards.count(),2);
  assert.equal(await page.getByRole('button',{name:'仅展示'}).isDisabled(),true);
  await page.getByRole('button',{name:'添加到本机'}).click();
  await page.getByRole('button',{name:'已添加',exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.fixture.adds.map(({accountId,id,kind})=>[accountId,id,kind])),[['owner','1','skin']]);
  await filters.getByRole('button',{name:'全部',exact:true}).click();
  const skillCard=cards.filter({has:page.getByRole('heading',{name:'常用 Skill',exact:true})});
  await skillCard.getByRole('button',{name:'添加到本机'}).click();
  await skillCard.getByRole('button',{name:'本机已有'}).waitFor();
  await skillCard.getByText('本机已有相同配置，未重复保存。').waitFor();
  await page.evaluate(()=>window.fixture.legacy=true);
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByText('服务暂未提供下载次数，按发布时间排列',{exact:false}).waitFor();
  assert.deepEqual(await cards.locator('h4').allTextContents(),['只展示皮肤','工具 MCP','阅读助手','深蓝皮肤','常用 Skill']);
  assert.equal(await page.locator('.community-market-count').count(),0);
  const upload=page.getByRole('button',{name:'上传插件',exact:true});
  assert.equal(await page.locator('.community-market-toolbar-actions button:has-text("刷新") + button').innerText(),'上传插件');
  await upload.click();
  await page.getByText('本周剩余 1 / 3 次',{exact:false}).waitFor();
  const selector=page.getByLabel('选择本机资源');
  await page.evaluate(()=>window.fixture.duplicate=true);
  await selector.selectOption('skill:mine');
  await page.getByText('相同配置已经投稿或上架，不能重复上传。').waitFor();
  await page.getByLabel('我有权分享此配置',{exact:false}).check();
  assert.equal(await page.getByRole('button',{name:'提交投稿'}).isDisabled(),true);
  await selector.selectOption('');
  await page.evaluate(()=>window.fixture.duplicate=false);
  await selector.selectOption('skill:mine');
  const send=page.getByRole('button',{name:'提交投稿'});
  await send.waitFor();assert.equal(await send.isDisabled(),true);
  await page.getByLabel('我有权分享此配置',{exact:false}).check();
  await send.click();
  await page.getByRole('alert').filter({hasText:'暂时无法完成社区请求'}).waitFor();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await upload.click();
  await page.getByText('本周额度已用完',{exact:false}).waitFor();
  await selector.selectOption('skill:mine');
  await page.getByLabel('我有权分享此配置',{exact:false}).check();
  await send.click();
  await page.getByText('投稿已提交，等待审核。').waitFor();
  const submissions=await page.evaluate(()=>window.fixture.submissions);
  assert.equal(submissions.length,2);
  assert.equal(submissions[0].key,submissions[1].key,'reuse the key after a lost response, including at zero quota');
  assert.equal(submissions[0].downloadAllowed,false);
  const minePanel=page.getByRole('region',{name:'我的投稿'});
  await minePanel.getByRole('button',{name:'下架',exact:true}).click();
  await minePanel.getByText('已下架',{exact:true}).waitFor();
  await minePanel.getByRole('button',{name:'撤回投稿',exact:true}).click();
  await minePanel.getByText('已撤回',{exact:true}).waitFor();
  const mineActions=await page.evaluate(()=>window.fixture.mineActions);
  assert.deepEqual(mineActions.map(action=>[action.id,action.action,action.revision,action.publishedRevision||null]),
    [['1','unpublish',2,1],['pending','withdraw',1,null]]);
  await filters.getByRole('button',{name:'全部',exact:true}).click();
  assert.equal(await page.getByRole('heading',{name:'深蓝皮肤',exact:true}).count(),0);
  await upload.click();
  await selector.selectOption('skill:mine');
  await page.getByLabel('我有权分享此配置',{exact:false}).check();
  assert.equal(await send.isDisabled(),true,'a new submission is blocked at zero quota');
  await page.setViewportSize({width:620,height:740});
  const layout=await page.locator('.application-settings-content').evaluate(el=>el.scrollWidth-el.clientWidth);
  assert(layout<=2,'market must not overflow horizontally');
  assert.deepEqual(errors,[]);
  console.log('PASS marketplace UI: browse/add, upload beside refresh, rules/quota, preview/consent, idempotent retry at zero, and narrow layout.');
} finally {
  await browser?.close();
  await new Promise(resolve=>server.httpServer.close(resolve));
}

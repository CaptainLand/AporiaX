import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
const server=await preview({preview:{host:'127.0.0.1',port:0,open:false}}),base=server.resolvedUrls.local[0];
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1280,height:950}}),errors=[];
  page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
  await page.addInitScript(()=>{
    if(!sessionStorage.avatarSeeded){localStorage.clear();localStorage.setItem('aporiax.language.v1','zh-CN');localStorage.setItem('aporiax.session-ui.v1',JSON.stringify({welcomeDismissed:true,taskId:'avatar-demo'}));sessionStorage.avatarSeeded='true';}
    localStorage.setItem('aporiax.theme.v2',new URLSearchParams(location.search).get('theme')||'light');
    const signed=()=>({status:'authenticated',profile:{id:window.avatarQA.owner,displayName:'演示用户',email:'demo@example.invalid'},session:{id:'demo-session'},quota:{remainingRatio:.82,cycleEnd:new Date(Date.now()+86400000*3).toISOString()},models:[{id:'demo-model',name:'演示 Cloud 模型'}],device:{name:'演示电脑'}});
    window.avatarQA={owner:'account-a',signed:true,opened:0};
    const task={id:'avatar-demo',title:'阅读项目说明',workspaceName:'演示工作区',workspacePath:'D:/Demo/Starlight',providerId:'demo-api',modelId:'demo-model',messages:[]};
    window.desktop={theme:{set:async()=>{}},providers:{list:async()=>[{id:'demo-api',name:'演示 API',models:[{id:'demo-model',name:'演示模型'}]}]},tasks:{load:async()=>[task],save:async()=>{}},
      harness:{onEvent:()=>()=>{},recoverableRuns:async()=>[]},sandbox:{status:async()=>({localAvailable:true})},
      account:{get:async()=>signed(),refresh:async()=>window.avatarQA.signed?signed():{status:'anonymous'},signOut:async()=>{window.avatarQA.signed=false;return{status:'anonymous'};},signIn:async()=>{window.avatarQA.signed=true;return signed();},openCenter:async()=>{window.avatarQA.opened++;},getRequestHistory:async()=>({items:[],nextCursor:null,sampledAt:new Date().toISOString()})},
      workspace:{listTree:async()=>({entries:[{path:'README.md',name:'README.md',type:'file'}]}),readPreview:async()=>({content:'# 演示文档\n\n文件工具栏预览。',binary:false})},
      workbench:{request:async({action})=>action==='list'?[]:true,subscribe:()=>()=>{}},
    };
  });
  const nav=page.locator('.application-settings-nav'),picker=page.locator('.account-avatar-choices');
  const profile=page.locator('.local-account-profile'),portrait=page.locator('.account-settings-profile .account-settings-avatar');
  const openSettings=async()=>{await page.getByRole('button',{name:'打开 AporiaX 设置',exact:true}).click();await nav.getByRole('button',{name:'账户',exact:true}).click();await page.locator('.account-avatar-trigger').waitFor();};
  const boot=async theme=>{await page.goto(base+'?theme='+theme);await page.locator('.ax-welcome__enter, .thread-view-tabs').first().waitFor();if(await page.locator('.ax-welcome__enter').isVisible())await page.locator('.ax-welcome__enter').click();await profile.waitFor();};
  const choose=async name=>{await page.getByRole('button',{name:'更换账户头像',exact:true}).click();await picker.getByRole('button',{name,exact:true}).click();};
  const decode=async locator=>locator.evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
  await mkdir('.tmp/qa/account-refresh',{recursive:true});
  for(const theme of ['light','dark']) {
    if(theme==='dark') await page.evaluate(()=>localStorage.removeItem('aporiax.account-agent-avatars.v1'));
    await boot(theme);await profile.click();
    assert.equal(await page.locator('.local-account-popover .local-account-avatar').getAttribute('data-avatar'),'main');await decode(page.locator('.local-account-popover img'));
    await page.locator('.local-account-popover').screenshot({path:`.tmp/qa/account-refresh/popover-${theme}.png`});await page.keyboard.press('Escape');assert.equal(await page.locator('.local-account-popover').count(),0);
    await openSettings();assert.equal(await portrait.getAttribute('data-avatar'),'main');
    await page.getByRole('button',{name:'更换账户头像',exact:true}).click();assert.equal(await picker.locator('.account-avatar-grid button').count(),6);
    await decode(picker.locator('img'));await page.screenshot({path:`.tmp/qa/account-refresh/avatar-picker-${theme}.png`});
    await page.keyboard.press('Escape');assert.equal(await picker.count(),0);assert.equal(await page.locator('.application-settings-modal').count(),1,'Escape closes only the avatar picker');
    await choose('探奇');assert.equal(await portrait.getAttribute('data-avatar'),'explore');
    await page.getByRole('button',{name:'刷新账户与用量',exact:true}).click();assert.equal(await portrait.getAttribute('data-avatar'),'explore');
    await page.getByRole('button',{name:'关闭设置',exact:true}).click();await profile.click();assert.equal(await page.locator('.local-account-popover .local-account-avatar').getAttribute('data-avatar'),'explore');await page.keyboard.press('Escape');
    await page.reload();if(await page.locator('.ax-welcome__enter').isVisible())await page.locator('.ax-welcome__enter').click();await openSettings();assert.equal(await portrait.getAttribute('data-avatar'),'explore','Selection persists on reload');
    await page.evaluate(()=>window.avatarQA.owner='account-b');await page.getByRole('button',{name:'刷新账户与用量',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.account-settings-avatar')?.dataset.avatar==='main');
    await choose('知序');assert.equal(await portrait.getAttribute('data-avatar'),'curator');
    await page.evaluate(()=>window.avatarQA.owner='account-a');await page.getByRole('button',{name:'刷新账户与用量',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.account-settings-avatar')?.dataset.avatar==='explore','Account A retains its separate choice');
    await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='aporiax.account-agent-avatars.v1')throw Error('Unavailable');return original.call(this,key,value);};window.avatarQA.restoreStorage=()=>Storage.prototype.setItem=original;});
    await choose('搭匠');await picker.getByRole('alert').waitFor();assert.equal(await portrait.getAttribute('data-avatar'),'explore','Failed persistence does not pretend to save');await page.evaluate(()=>window.avatarQA.restoreStorage());await picker.getByRole('button',{name:'阿珀',exact:true}).click();
    await nav.getByRole('button',{name:'通用',exact:true}).click();await page.screenshot({path:`.tmp/qa/account-refresh/general-${theme}.png`});
    await page.getByRole('button',{name:'关闭设置',exact:true}).click();await page.locator('.thread-view-tabs').getByRole('button',{name:'工作区',exact:true}).click();await page.getByRole('button',{name:/README.md/}).first().click();await page.getByRole('heading',{name:'演示文档',exact:true}).waitFor();
    const toolbar=page.locator('.workbench-file .document-toolbar');await toolbar.getByRole('button',{name:'源码',exact:true}).click();await toolbar.getByRole('button',{name:'阅读',exact:true}).click();
    const colors=await toolbar.getByRole('button',{name:'阅读',exact:true}).evaluate(el=>{const s=getComputedStyle(el);return[s.backgroundColor,s.color];});
    for(const color of colors){const channels=color.match(/\d+/g).slice(0,3).map(Number);assert(Math.max(...channels)-Math.min(...channels)<12,`Neutral file mode: ${color}`);}
    await toolbar.screenshot({path:`.tmp/qa/account-refresh/file-modes-${theme}.png`});
  }
  await page.setViewportSize({width:740,height:800});await openSettings();await page.getByRole('button',{name:'更换账户头像',exact:true}).click();const box=await picker.boundingBox();assert(box.x>=0&&box.x+box.width<=740);await page.screenshot({path:'.tmp/qa/account-refresh/avatar-picker-narrow.png'});
  assert.deepEqual(errors,[]);console.log('PASS account avatar: six choices, popover synchronization, persisted reload, account isolation, save failure, Escape/focus, light/dark/narrow; General and neutral file mode controls verified.');
} finally {await browser.close();await new Promise(resolve=>server.httpServer.close(resolve));}

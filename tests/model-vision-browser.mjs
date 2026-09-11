import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { normalizeProviderInput, publicProviderSummary } from '../electron/provider-config.js';
import { exposeVisionProxyCapabilities } from '../electron/vision-proxy-core.js';
let record=normalizeProviderInput({id:'ds',baseUrl:'https://unused.invalid',models:[{id:'deepseek-v4.1-flash',supportsImages:false}]});
const server=await createServer({server:{host:'127.0.0.1',port:0,open:false,watch:null}});
let browser;
try{
 await server.listen();
 browser=await chromium.launch({executablePath:process.env.TEST_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1024,height:850}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/__vision_provider',async route=>{
   if(route.request().method()==='POST') record=normalizeProviderInput({...record,...route.request().postDataJSON()},record);
   await route.fulfill({json:exposeVisionProxyCapabilities([publicProviderSummary({...record,encryptedKey:'fixture-only'}),{id:'aporia-cloud',kind:'aporia-cloud',visionCapability:{status:'unknown'},models:[]}])});
 });
 const url=server.resolvedUrls.local[0]+'tests/fixtures/model-vision.html';
 await page.goto(url);
 const select=page.getByRole('combobox');await select.waitFor();
 assert.equal(await select.inputValue(),'native');
 assert.equal(await page.getByText('Qwen3.5-Flash',{exact:true}).count(),0);
 await select.selectOption('native');await page.getByRole('button',{name:'Save configuration'}).click();await page.getByText('Saved',{exact:true}).waitFor();
 assert.equal(record.models[0].supportsImages,true);
 await page.reload();await select.waitFor();assert.equal(await select.inputValue(),'native');
 await page.getByText('图片输入已配置',{exact:true}).waitFor();
 await select.selectOption('text');await page.getByRole('button',{name:'Save configuration'}).click();await page.getByText('Saved',{exact:true}).waitFor();
 assert.equal(record.models[0].supportsImages,false);
 await page.getByText('图片输入尚未就绪',{exact:true}).waitFor();
 for(const lang of ['zh-CN','en'])for(const theme of ['light','dark']){
   await page.goto(url+`?lang=${lang}&theme=${theme}`);await select.waitFor();
   const fits=await page.locator('.model-vision-row').evaluate(el=>{const select=el.querySelector('select');return el.scrollWidth<=el.clientWidth+1&&select.getBoundingClientRect().width>=100;});
   assert(fits,'model capability options must fit a 304px panel');
 }
 await mkdir('.tmp/settings-regression',{recursive:true});
 await page.goto(url);await select.waitFor();await select.selectOption('native');
 await page.locator('.model-vision-settings').screenshot({path:'.tmp/settings-regression/model-vision-fixed.png'});
 assert.deepEqual(errors,[]);
 console.log('Vision settings in real browser: native/text save & reload, truthful unavailable state, no phantom Qwen, bilingual light/dark at 304px: PASS');
}finally{await browser?.close();await server.close();}

import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
const server=await createServer({server:{host:'127.0.0.1',port:0,open:false,watch:null}});await server.listen();
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--enable-unsafe-swiftshader']});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1040}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]+'tests/fixtures/mascot-lineup.html');await page.waitForFunction(()=>window.mascotLineup);
  const data=await page.evaluate(()=>window.mascotLineup.diagnostics());assert.equal(Object.keys(data.models).length,6);assert(new Set(Object.values(data.models)).size===6);assert(data.triangles>30000&&data.triangles<50000);
  await mkdir('.tmp/qa',{recursive:true});await page.screenshot({path:'.tmp/qa/team-mascots-lineup.png'});
  for(const role of ['main','explore','review','verify','builder','curator']){await page.evaluate(role=>window.mascotLineup.focus(role),role);await page.screenshot({path:`.tmp/qa/mascot-${role}-3d.png`});}
  await page.evaluate(()=>window.mascotLineup.faces());await page.screenshot({path:'.tmp/qa/team-mascots-expressions.png'});
  await page.evaluate(()=>window.mascotLineup.faces('sleeping'));await page.screenshot({path:'.tmp/qa/team-mascots-sleeping.png'});
  assert.deepEqual(errors,[]);console.log('PASS model lineup: six distinct local models render; individual front/three-quarter views captured.');
}finally{await browser.close();await server.close();}

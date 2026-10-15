import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright-core";
const server = await createServer({ server: { host:"127.0.0.1",port:0,open:false,watch:null } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath:"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",headless:true });
  const page = await browser.newPage({ viewport:{width:1200,height:900},bypassCSP:true });
  const errors=[]; page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("aporiax.language.v1","zh-CN");
    const listeners = new Set(), calls = [];
    let status = { phase:"idle",channel:"nsis",currentVersion:"1.0.0-preview.3",packaged:true };
    const emit = patch => { status={...status,...patch}; for(const fn of listeners) fn(status); return status; };
    window.updateFixture = { calls, emit };
    window.desktop = {
      theme:{set:async()=>{}},providers:{list:async()=>[]},
      tasks:{load:async()=>[],save:async()=>{}},harness:{onEvent:()=>()=>{},recoverableRuns:async()=>[]},
      sandbox:{status:async()=>({localAvailable:true})},
      update:{
        status:async()=>status,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
        check:async options=>{calls.push(["check",options]);return emit({phase:"available",availableVersion:"1.0.0-preview.4",busy:false,error:""});},
        download:async()=>{calls.push(["download"]);return emit({phase:"downloaded",downloadPercent:100});},
        install:async()=>{calls.push(["install"]);return emit({error:"TASK_RUNNING"});},
        openRelease:async(options)=>{calls.push(["open",options]);return status;},
      },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(()=>window.updateFixture.calls.length>0);
  // Check is performed even while the welcome screen remains open.
  if(await page.locator(".ax-welcome__enter").isVisible()) await page.locator(".ax-welcome__enter").click();
  const sidebar = page.locator(".app-update-sidebar");
  await sidebar.getByRole("button",{name:/有新版本更新/}).waitFor();
  await page.evaluate(()=>window.updateFixture.emit({phase:"not-available",availableVersion:"",busy:false}));
  await sidebar.waitFor({state:"detached"});
  await page.evaluate(()=>window.updateFixture.emit({phase:"checking",busy:true}));
  await sidebar.getByRole("button",{name:/正在检查更新/}).waitFor();
  await page.evaluate(()=>window.updateFixture.emit({phase:"available",availableVersion:"1.0.0-preview.4",busy:false}));
  if(await page.locator(".app-update-toast").isVisible()) await page.locator(".app-update-toast").getByRole("button",{name:"稍后"}).click();
  assert.equal(await sidebar.isVisible(),true);
  await sidebar.getByRole("button",{name:/有新版本更新/}).click();
  await sidebar.getByRole("button",{name:/重启安装/}).click();
  await sidebar.getByText(/有任务正在运行/).waitFor();
  await page.evaluate(()=>window.updateFixture.emit({channel:"portable",phase:"available",error:"",mirrorAvailable:true}));
  await sidebar.getByRole("button",{name:/有新版本更新/}).click();
  assert.equal(await page.evaluate(()=>window.updateFixture.calls.at(-1)[0]),"open");
  await sidebar.getByRole('button',{name:/备用下载/}).click();
  assert.equal(await page.evaluate(()=>window.updateFixture.calls.at(-1)[1].source),'mirror');
  await page.evaluate(()=>window.updateFixture.emit({phase:"error",availableVersion:"",error:"offline"}));
  await sidebar.getByRole("button",{name:/重试/}).click();
  assert.equal(await page.evaluate(()=>window.updateFixture.calls.at(-1)[1].force),true);
  await mkdir(".tmp/update-preview4",{recursive:true});
  await page.screenshot({path:".tmp/update-preview4/sidebar-light.png"});
  await page.evaluate(()=>document.documentElement.dataset.theme="dark");
  await page.screenshot({path:".tmp/update-preview4/sidebar-dark.png"});
  const box=await sidebar.boundingBox(); assert(box.x<350 && box.y>500);
  assert.deepEqual(errors,[]);
  console.log("PASS actual app: launch check on welcome, signed-out bottom-left badge, toast dismissal, download/install guard, portable link, error retry; no page errors");
} finally { await browser?.close(); await server.close(); }

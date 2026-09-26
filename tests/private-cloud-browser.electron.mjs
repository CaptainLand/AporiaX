import assert from 'node:assert/strict';
import {app,shell} from 'electron';
import {execFileSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {chromium} from 'playwright-core';
import {readPrivateProfile,createPrivateCloudBridge} from '../electron/account/private-cloud-bridge.js';
import {fileURLToPath} from 'node:url';
const profile=mkdtempSync(join(tmpdir(),'aporia-private-cloud-browser-'));
app.setPath('userData',profile);
const sshArgs=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-i',join(homedir(),'.ssh','aporiax_cloud_preview_ed25519'),'ubuntu@101.43.44.160'];
const command='cd /srv/aporiax-cloud-preview && sudo -n bash deploy/private-preview/compose.sh exec -T api node -';
const fixtureInput=' < scripts/private-preview-browser-fixture.cjs';
let fixture,browser,runtime;
const oneclick=process.argv.includes('--oneclick');
app.whenReady().then(async()=>{
try {
  fixture=JSON.parse(execFileSync('ssh',[...sshArgs,command+fixtureInput],{encoding:'utf8',timeout:15000,windowsHide:true}));
  browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const context=await browser.newContext();
  await context.addCookies([{name:'aporia_refresh',value:fixture.refresh,domain:'localhost',path:'/auth',httpOnly:true,secure:true,sameSite:'Lax'}]);
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('aporia-language','zh'));
  shell.openExternal=async url=>{
    assert.equal(new URL(url).origin,'http://localhost:15173');
    await page.goto(url);
    await page.getByRole('button',{name:'确认并连接',exact:true}).click({timeout:20000});
  };
  const {createDesktopAccountRuntime}=await import('../electron/account/desktop-account-runtime.js');
  const makeOptions=()=>oneclick ? createPrivateCloudBridge({
    profile:readPrivateProfile(join(homedir(),'AppData/Roaming/AporiaX/cloud-private-preview.json')),
    userDataPath:profile,
    webRoot:fileURLToPath(new URL('../.tmp/aporiax-web-guide/.tmp/private-preview-web',import.meta.url)),
  }).options : {webBaseUrl:'http://localhost:15173',apiBaseUrl:'http://localhost:14100',modelGatewayBaseUrl:'http://localhost:14200'};
  runtime=createDesktopAccountRuntime(makeOptions());
  const snapshot=await runtime.startBrowserLogin();
  assert.equal(snapshot.status,'authenticated');
  assert.equal(snapshot.gatewayStatus,'verified');
  assert.equal(snapshot.gatewayCapabilities.protocolVersion,1);
  const flash=snapshot.gatewayCapabilities.models.find(m=>m.id==='aporia-cloud-default');
  assert.equal(flash.available,true,flash.reason);
  assert.equal(snapshot.capabilities.remote.supported,false);
  const refreshed=await runtime.refresh();assert.equal(refreshed.status,'authenticated');
  await runtime.close();runtime=createDesktopAccountRuntime(makeOptions());
  assert.equal((await runtime.getSnapshot()).status,'authenticated','Encrypted desktop refresh token must survive recreation');
  await page.goto('http://localhost:15173/');assert.equal(await page.locator('body').isVisible(),true);
  await page.reload();await page.waitForTimeout(700);
  assert.equal(errors.length,0,errors.join('; '));
  await runtime.signOut();assert.equal((await runtime.getSnapshot()).status,'anonymous');
  console.log('PASS: real Web authorization UI -> PKCE callback -> desktop token exchange -> capabilities/Flash -> refresh -> encrypted session reload -> logout; no model request sent.');
} catch(error) {
  console.error('Private browser E2E failed:',error.message);process.exitCode=1;
} finally {
  await runtime?.close();await browser?.close();
  if(fixture)execFileSync('ssh',[...sshArgs,command+' cleanup '+fixture.user+fixtureInput],{stdio:['ignore','ignore','pipe'],windowsHide:true,timeout:15000});
  app.exit(process.exitCode||0);
}
});

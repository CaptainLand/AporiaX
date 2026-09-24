import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, '.tmp', 'aporiax-web-guide');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name)+1] : fallback;
const server = option('--server', '101.43.44.160');
const key = option('--key', join(homedir(), '.ssh', 'aporiax_cloud_preview_ed25519'));
const endpoints = {APORIAX_ACCOUNT_WEB_URL:'http://localhost:15173',APORIAX_CLOUD_API_URL:'http://localhost:14100',APORIAX_MODEL_GATEWAY_URL:'http://localhost:14200'};
const children = new Set();
let stopping = false;
function stop(code=0) {
  if (stopping) return; stopping=true;
  for (const child of children) child.kill();
  process.exitCode=code;
}
function start(command, argv, cwd=root, env=process.env) {
  const child = spawn(command, argv, {cwd,env,windowsHide:true,stdio:['ignore','inherit','inherit']});
  children.add(child);
  child.on('error', error => { console.error('Preview helper failed:',error.code || error.name); stop(1); });
  child.on('exit', code => {children.delete(child); if (!stopping) {console.error('Preview helper exited:',code);stop(code || 0);}});
  return child;
}
async function freePort(port) {
  await new Promise((done,reject)=>{const socket=createServer();socket.once('error',reject);socket.listen(port,'127.0.0.1',()=>socket.close(done));});
}
async function ready(url, json=false) {
  for(let i=0;i<40;i++){
    if(stopping)throw Error('Helper stopped');
    try {const r=await fetch(url,{signal:AbortSignal.timeout(1000)});if(r.ok&&(!json||(await r.json()).ok))return;}catch{}
    await new Promise(r=>setTimeout(r,250));
  } throw Error('Private preview did not become ready: '+url);
}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
try {
  if(!existsSync(key))throw Error('SSH key not found.');
  if(!existsSync(join(web,'.tmp','private-preview-web','index.html')))throw Error('Build private Web first; see docs/cloud-private-preview-2026-09-23.md');
  for(const port of [14100,14200,15173])await freePort(port);
  start('ssh',['-n','-N','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-i',key,'-L','127.0.0.1:14100:127.0.0.1:14100','-L','127.0.0.1:14200:127.0.0.1:14200','ubuntu@'+server]);
  await ready('http://127.0.0.1:14100/health',true);
  await ready('http://127.0.0.1:14200/health',true);
  start(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','15173','--strictPort','--outDir','.tmp/private-preview-web'],web);
  await ready('http://127.0.0.1:15173/');
  console.log('Private Cloud ready: http://localhost:15173 (keep this terminal open; Ctrl+C disconnects).');
  if(!args.includes('--no-desktop')){
    console.log('Close any existing AporiaX instance first; this launch uses the private endpoints only.');
    start(process.execPath,['node_modules/electron/cli.js','.'],root,{...process.env,...endpoints});
  }
}catch(error){console.error(error.message);stop(1);}

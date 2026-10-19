import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const parent=resolve('.tmp/community-runtime-temp');await mkdir(parent,{recursive:true});
const directory=await mkdtemp(join(parent,'avatar-runtime-'));
globalThis.__avatarElectron={app:{getPath:()=>directory,getVersion:()=> '1.0.2'},safeStorage:{},shell:{}};
let source=await readFile('electron/account/desktop-account-runtime.js','utf8');
source=source.replace('import { app, safeStorage, shell } from "electron";','const {app,safeStorage,shell}=globalThis.__avatarElectron;')
  .replace('let currentSnapshot = emptySnapshot();',"let currentSnapshot={status:'authenticated',profile:{id:'fixture',displayName:'Fixture'}};")
  .replace('let accessToken = "";',"let accessToken='fixture-token';")
  .replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,quote,path)=>'from '+JSON.stringify(pathToFileURL(resolve('electron/account',path)).href));
const {createDesktopAccountRuntime}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const original=globalThis.fetch;let status=200,wait=null,requests=[];
globalThis.fetch=async(url,init)=>{
  requests.push({url,init});if(url.endsWith('/auth/logout'))return Response.json({ok:true});
  if(wait)await wait;
  return Response.json(status===200?{id:'fixture',avatarTemplate:JSON.parse(init.body).avatarTemplate,avatarTemplateUpdatedAt:new Date().toISOString()}:{error:'PRIVATE_API_KEY=should-never-leak'},{status});
};
const runtime=createDesktopAccountRuntime({apiBaseUrl:'https://api.example.invalid',webBaseUrl:'https://web.example.invalid',modelGatewayBaseUrl:'https://gateway.example.invalid',endpointManifest:join(directory,'missing')});
try{
  for(const input of [{accountId:'fixture',template:'photo'},{accountId:'fixture',template:'review',url:'https://evil.invalid'},{accountId:'fixture',template:'review',initializeOnly:'yes'}])await assert.rejects(()=>runtime.setAvatarTemplate(input),/ACCOUNT_AVATAR_INVALID/);
  await assert.rejects(()=>runtime.setAvatarTemplate({accountId:'other',template:'review'}),/DESKTOP_ACCOUNT_CHANGED/);assert.equal(requests.length,0);
  const saved=await runtime.setAvatarTemplate({accountId:'fixture',template:'review'});assert.equal(saved.profile.avatarTemplate,'review');assert(saved.profile.avatarTemplateUpdatedAt);
  assert.equal(requests[0].url,'https://api.example.invalid/me');assert.equal(requests[0].init.method,'PATCH');assert.deepEqual(JSON.parse(requests[0].init.body),{avatarTemplate:'review'});
  await runtime.setAvatarTemplate({accountId:'fixture',template:'verify',initializeOnly:true});assert.deepEqual(JSON.parse(requests[1].init.body),{avatarTemplate:'verify',initializeAvatarOnly:true});
  status=500;await assert.rejects(()=>runtime.setAvatarTemplate({accountId:'fixture',template:'main'}),/^Error: ACCOUNT_AVATAR_SAVE_FAILED$/);status=200;
  let release;wait=new Promise(resolve=>release=resolve);const pending=runtime.setAvatarTemplate({accountId:'fixture',template:'builder'}),reject=assert.rejects(pending,/DESKTOP_ACCOUNT_CHANGED/);
  await runtime.signOut();release();await reject;
  console.log('PASS avatar IPC runtime: enum-only fixed /me transport, strict input, owner/session guard, insert-only migration body, safe errors, logout during request.');
}finally{await runtime.close();globalThis.fetch=original;delete globalThis.__avatarElectron;assert(directory.startsWith(parent+'\\'));await rm(directory,{recursive:true,force:true});}

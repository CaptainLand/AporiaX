import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {defaultAppearance,PRESET_COLORS} from '../shared/appearance.js';
import {defaultRoleSettings} from '../shared/professional-roles.js';
import {localResourceCatalog,exportLocalResource,createLocalRepositorySync} from '../electron/community/local-repository.js';

const parent=resolve('.tmp/community-runtime-temp');await mkdir(parent,{recursive:true});
const root=await mkdtemp(join(parent,'local-repository-test-'));
try{
  for(const path of ['skills/review','appearance','security'])await mkdir(join(root,path),{recursive:true});
  await writeFile(join(root,'skills/review/SKILL.md'),'# Review\nRead the diff, then report risks. Private path: D:\\Users\\Alice\\work');
  const secret='a-literal-private-token-123456789';
  await writeFile(join(root,'aporiax-mcp.json'),JSON.stringify({servers:[{id:'example',name:'Example',transport:'stdio',command:'D:\\private\\server.exe',args:['--token',secret,'--password=another-private-secret','https://alice:pass@example.invalid/mcp?token=other-secret','D:\\private\\data'],env:{API_TOKEN:secret},cwd:'D:\\private'},{id:'remote',transport:'streamable-http',url:'https://alice:pass@example.invalid/mcp?key=secret',headers:{Authorization:'Bearer '+secret}}]}));
  const themeId='theme-'+randomUUID();
  await writeFile(join(root,'appearance/themes.json'),JSON.stringify({...defaultAppearance(),themes:[{id:themeId,name:'Test mint',base:'light',colors:PRESET_COLORS.light,source:'manual',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}]}));
  const roles=defaultRoleSettings();roles.profiles[0].instructions='Be concise. Project D:\\private\\project';
  roles.profiles.push(...roles.profiles.map(role=>({...role,id:'custom-'+role.id,name:'Custom '+role.name})));
  await writeFile(join(root,'security/professional-roles.json'),JSON.stringify(roles));
  const catalog=await localResourceCatalog(root);assert.equal(catalog.filter(item=>item.uploadable).length,9);assert.doesNotMatch(JSON.stringify(catalog),new RegExp(secret));
  const mcpConfig=JSON.parse(await readFile(join(root,'aporiax-mcp.json'),'utf8'));
  mcpConfig.servers.push({id:'filesystem',name:'Renamed official',command:'node',args:[]},{id:'my-browser',name:'My browser',command:'npx',args:['-y','@playwright/mcp@0.0.81']},{id:'my-docs',name:secret,url:'https://mcp.context7.com/mcp?key=private',headers:{'X-Key':secret},transport:'streamable-http'});
  await writeFile(join(root,'aporiax-mcp.json'),JSON.stringify(mcpConfig));
  for(const id of ['filesystem','my-browser','my-docs']){assert((await localResourceCatalog(root)).some(item=>item.id==='mcp:'+id&&item.builtin&&!item.uploadable));await assert.rejects(()=>exportLocalResource(root,'mcp:'+id),/BUILTIN_RESOURCE/);}
  assert.doesNotMatch(JSON.stringify(await localResourceCatalog(root)),new RegExp(secret));
  assert.deepEqual(JSON.parse(await readFile('shared/community-builtins.json','utf8')),JSON.parse(await readFile('.tmp/aporiax-cloud-server-preview/packages/community/src/builtins.json','utf8')),'desktop and API official identifiers must match');
  for(const id of ['agent:explore','agent:review','agent:verify','agent:curator','agent:builder','skill:create-aporiax-theme','skill:word-design']){assert(catalog.some(item=>item.id===id&&item.builtin&&!item.uploadable));await assert.rejects(()=>exportLocalResource(root,id),/BUILTIN_RESOURCE/);}
  for(const id of ['skill:review','mcp:example','mcp:remote','skin:'+themeId,'agent:custom-explore']){
    const value=await exportLocalResource(root,id);assert.match(value.sourceKey,new RegExp('^'+value.kind+':[a-f0-9]{64}$'));
    assert.doesNotMatch(JSON.stringify(value),/a-literal-private-token|another-private-secret|other-secret|D:\\\\private|alice:pass/);
    if(value.kind==='mcp'){const config=Object.values(JSON.parse(value.content).mcpServers)[0];if(config.env)assert.equal(config.env.API_TOKEN,'${API_TOKEN}');if(config.url)assert.equal(config.url,'https://example.invalid/mcp');}
  }
  await assert.rejects(()=>exportLocalResource(root,'skill:../../outside'),/NOT_FOUND/);
  let owner='owner-1',posts=0,confirmed=0,previous=[];
  const account={apiBaseUrl:'http://127.0.0.1:14119',getSnapshot:async()=>({status:'authenticated',profile:{id:owner,displayName:'Test account'}}),communityRepositoryRequest:async(action,input,id)=>{assert.equal(id,owner);if(action==='list')return {items:previous,hasMore:false};posts++;assert.equal(input.consent,true);assert(input.entries.length<=5);assert(!('warnings' in input.entries[0]));return {items:input.entries};}};
  const canceled=createLocalRepositorySync({userDataDirectory:root,account,confirm:async info=>{confirmed++;assert.equal(info.items.length,1);return false;}});
  assert.equal((await canceled.list()).cloudSyncDefault,false);assert.equal((await canceled.sync({ids:['mcp:example']})).canceled,true);assert.equal(posts,0);
  const changed=createLocalRepositorySync({userDataDirectory:root,account,confirm:async()=>{owner='owner-2';return true;}});
  await assert.rejects(()=>changed.sync({ids:['mcp:example']}),/ACCOUNT_CHANGED/);assert.equal(posts,0);
  const accepted=createLocalRepositorySync({userDataDirectory:root,account,confirm:async()=>true});
  const exported=await exportLocalResource(root,'mcp:example');previous=[{source_key:exported.sourceKey,sha256:'a'.repeat(64),revision:3}];
  const result=await accepted.sync({ids:['mcp:example']});assert.equal(result.uploaded,1);assert.equal(result.items[0].expectedRevision,3);assert.equal(posts,1);assert.equal(confirmed,1);
  await assert.rejects(()=>accepted.sync({ids:['skill:review'],path:'D:\\private'}),/INVALID_SELECTION/);
  await writeFile(join(root,'skills/review/extra.md'),'attachment');await assert.rejects(()=>accepted.sync({ids:['skill:review']}),/PACKAGE_NOT_SUPPORTED/);assert.equal(posts,1);
  let allConfirms=0;
  const all=createLocalRepositorySync({userDataDirectory:root,account,confirm:async info=>{allConfirms++;assert.equal(info.items.length,8);assert.equal(info.skipped.length,1);return true;}});
  const identity={accountId:owner,apiBaseUrl:account.apiBaseUrl};
  const detected=await all.detectAll(identity);assert.equal(detected.eligibleTotal,9);assert.equal(detected.total,detected.eligibleTotal+detected.builtinTotal);assert.equal(detected.resources.length,detected.total);assert.equal(posts,1,'detect only reads metadata');
  assert.deepEqual(await all.detectAll(identity),detected,'repeat detection must not accumulate resources in the bundled metadata cache');
  await assert.rejects(()=>all.detectAll({...identity,accountId:'other'}),/ACCOUNT_CHANGED/);
  await assert.rejects(()=>all.detectAll({...identity,apiBaseUrl:'https://other.invalid'}),/SERVICE_MISMATCH/);
  const allResult=await all.syncAll(identity);assert.equal(allConfirms,1);assert.equal(allResult.uploaded,8);assert.equal(posts,3,'two batches behind one confirmation');assert.equal(allResult.complete,false);assert.equal(allResult.skipped[0].code,'COMMUNITY_SKILL_PACKAGE_NOT_SUPPORTED');
  assert.equal(allResult.excluded.length,detected.builtinTotal);
  const canceledAll=createLocalRepositorySync({userDataDirectory:root,account,confirm:async()=>false});assert.equal((await canceledAll.syncAll(identity)).canceled,true);assert.equal(posts,3);
  const partialAccount={...account,communityRepositoryRequest:async(action,input,id)=>{if(action==='list')return {items:[],hasMore:false};if(input.entries.length<5)throw Error('COMMUNITY_REPOSITORY_CONFLICT');return {items:input.entries};}};
  const partial=await createLocalRepositorySync({userDataDirectory:root,account:partialAccount,confirm:async()=>true}).syncAll(identity);assert.equal(partial.uploaded,5);assert.equal(partial.complete,false);assert.equal(partial.error,'COMMUNITY_REPOSITORY_CONFLICT');
  await rm(join(root,'skills/review/extra.md'));await writeFile(join(root,'skills/review/SKILL.md'),'sk-'+ 'a'.repeat(32));await assert.rejects(()=>exportLocalResource(root,'skill:review'),/SECRET_DETECTED/);
  await writeFile(join(root,'skills/review/SKILL.md'),'x'.repeat(262145));await assert.rejects(()=>exportLocalResource(root,'skill:review'),/TOO_LARGE/);
  await rm(join(root,'appearance'),{recursive:true});await mkdir(join(root,'linked-store'));await writeFile(join(root,'linked-store/themes.json'),'{}');await symlink(join(root,'linked-store'),join(root,'appearance'),'junction');await assert.rejects(()=>localResourceCatalog(root),/UNSAFE_RESOURCE/);
  console.log('PASS local repository: all four resource types, explicit consent/cancel, account switch guard, selection validation, safe metadata, MCP redaction, private paths removed, revision preconditions, no partial Skill packages, secret/size/symlink rejection.');
}finally{assert(root.startsWith(parent+'\\'));await rm(root,{recursive:true,force:true});}

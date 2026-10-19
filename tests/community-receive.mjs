import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createCommunityReceiver,receivedResources,readReceiveLog} from '../electron/community/receive.js';
import {createLocalRepositorySync,exportLocalResource} from '../electron/community/local-repository.js';
import {createAppearanceStore} from '../electron/appearance/store.js';
import {createRoleSettingsStore} from '../electron/harness/role-settings.js';
import {PRESET_COLORS} from '../shared/appearance.js';
const parent=resolve('.tmp/community-runtime-temp');await mkdir(parent,{recursive:true});
const root=await mkdtemp(join(parent,'receive-')),other=await mkdtemp(join(parent,'receive-other-'));
const hash=value=>createHash('sha256').update(value).digest('hex'),api='https://api.example.invalid',owner=randomUUID();
const receiverFor=async directory=>{const appearance=await createAppearanceStore(directory),roles=await createRoleSettingsStore(directory);return {receiver:createCommunityReceiver({root:directory,appearanceStore:async()=>appearance,roleStore:async()=>roles}),appearance,roles};};
const file=(kind,data)=>{const content=kind==='skill'?data:JSON.stringify(data);return {id:randomUUID(),kind,title:'A community creation',summary:'Published fixture',fileName:kind==='skill'?'SKILL.md':kind+'.json',content,sha256:hash(content),revision:1,originId:randomUUID(),originRevision:1,originAuthorId:randomUUID()};};
try{
  const {receiver,appearance,roles}=await receiverFor(root);
  const files=[file('skill','---\nname: own-skill\nauto: true\ntriggers: [test]\nhooks: unsafe\n---\nRead the diff and report.'),file('mcp',{mcpServers:{own:{command:'node',args:['server.js'],env:{KEY:'${KEY}'}}}}),file('skin',{name:'Own colors',base:'light',colors:PRESET_COLORS.light}),file('agent',{name:'Own member',systemPrompt:'Be concise.',skillIds:['own-skill']})];
  for(const resource of files){receiver.validate(resource);const saved=await receiver.save(resource,owner,api);assert.equal(saved.saved,true);assert.equal((await receiver.save(resource,owner,api)).unchanged,true);}
  assert.equal((await receivedResources(root,owner,api)).items.length,4);assert.equal((await receivedResources(root,randomUUID(),api)).items.length,0);assert.equal((await receivedResources(root,owner,'https://other.example.invalid')).items.length,0);assert.equal((await receivedResources(other,owner,api)).items.length,0,'other device still NEW');
  const log=await readReceiveLog(root);assert.equal(log.items.length,4);const skill=log.items.find(row=>row.kind==='skill');
  const installed=await readFile(join(root,'skills',skill.localId,'SKILL.md'),'utf8');assert.match(installed,/auto: false/);assert.doesNotMatch(installed,/hooks:|triggers:/);
  await assert.rejects(()=>exportLocalResource(root,'skill:'+skill.localId),/IMPORTED_RESOURCE/);
  const mcp=JSON.parse(await readFile(join(root,'aporiax-mcp.json'),'utf8'));assert.equal(mcp.servers[0].enabled,false);assert.equal(mcp.servers[0].autoApproveReadOnly,false);assert.equal(mcp.servers[0].env.KEY,'${KEY}');
  assert.equal(appearance.snapshot().selectedId,null);assert.equal(appearance.snapshot().themes.length,1);const agent=roles.snapshot().profiles.find(row=>row.id.startsWith('community-'));assert.equal(agent.enabled,false);assert.deepEqual(agent.tools,[]);assert.deepEqual(agent.skills,[]);assert.equal(agent.knowledge,'off');
  await writeFile(join(root,'skills',skill.localId,'SKILL.md'),'My edited local copy');
  mcp.servers[0].enabled=true;mcp.servers[0].env.KEY='local-test-credential';
  await writeFile(join(root,'aporiax-mcp.json'),JSON.stringify(mcp));
  const roleFile=JSON.parse(await readFile(join(root,'security','professional-roles.json'),'utf8'));roleFile.profiles.find(row=>row.id===agent.id).enabled=true;
  await writeFile(join(root,'security','professional-roles.json'),JSON.stringify(roleFile));
  const modified=(await receivedResources(root,owner,api)).items;assert.equal(modified.length,4,'normal configuration and edits remain received');
  for(const kind of ['skill','mcp','agent'])assert.equal(modified.find(row=>row.id===files.find(file=>file.kind===kind).id).localStatus,'modified');
  assert(!JSON.stringify(modified).includes('local-test-credential'),'receipts never expose credentials');
  for(const resource of files)assert.equal((await receiver.save(resource,owner,api)).unchanged,true,'retry cannot overwrite configured copies');
  assert.equal(JSON.parse(await readFile(join(root,'aporiax-mcp.json'),'utf8')).servers[0].enabled,true);
  assert.equal(await readFile(join(root,'skills',skill.localId,'SKILL.md'),'utf8'),'My edited local copy');
  const next={...files[0],content:'# New version',revision:2,originRevision:2,sha256:hash('# New version')};assert.equal((await receiver.save(next,owner,api)).saved,true);assert.equal(await readFile(join(root,'skills',skill.localId,'SKILL.md'),'utf8'),'My edited local copy','new version is another copy');
  const bad={...next,sha256:'0'.repeat(64)};assert.throws(()=>receiver.validate(bad),/INVALID_RESOURCE/);
  const unsafe=file('mcp',{mcpServers:{own:{command:'node',enabled:true}}});assert.throws(()=>receiver.validate(unsafe),/INVALID_RESOURCE/);
  receiver.validate(file('agent',{name:'Boundary',systemPrompt:'a'.repeat(16000)}));
  assert.throws(()=>receiver.validate(file('agent',{name:'Too long',systemPrompt:'a'.repeat(16001)})),/INVALID_RESOURCE/);
  receiver.validate(file('agent',{name:'Combined',systemPrompt:'a'.repeat(15997),style:'b'}));
  assert.throws(()=>receiver.validate(file('agent',{name:'Combined overflow',systemPrompt:'a'.repeat(15998),style:'b'})),/INVALID_RESOURCE/);
  let signed=owner,confirm=false;const fresh=file('skill','# Private imported fixture');
  const sync=createLocalRepositorySync({userDataDirectory:root,account:{apiBaseUrl:api,getSnapshot:async()=>({status:'authenticated',profile:{id:signed}}),communityRepositoryRequest:async action=>{assert.equal(action,'content');return fresh;}},confirmReceive:async()=>confirm,receiver});
  const input={accountId:owner,apiBaseUrl:api,id:fresh.id,sha256:fresh.sha256,revision:1};assert.equal((await sync.pull(input)).canceled,true);assert(!(await sync.received(input)).items.some(row=>row.id===fresh.id));confirm=true;assert.equal((await sync.pull(input)).saved,true);assert.equal((await sync.pull(input)).unchanged,true);
  signed=randomUUID();await assert.rejects(()=>sync.pull(input),/ACCOUNT_CHANGED/);
  const dangerous=await mkdtemp(join(parent,'receive-link-'));try{await mkdir(join(dangerous,'target'));await symlink(join(dangerous,'target'),join(dangerous,'skills'),'junction');const {receiver:blocked}=await receiverFor(dangerous);await assert.rejects(()=>blocked.save(file('skill','# blocked'),owner,api),/UNSAFE_RESOURCE/);}finally{assert(dangerous.startsWith(parent+'\\'));await rm(dangerous,{recursive:true,force:true});}
  console.log('PASS community receive: four real local stores; no activation; per-account/service/device receipts; enabled/configured/edited copies stay received; credentials stay private; retries preserve local edits; separate new-version copy; Agent combined size limits; provenance upload denial; strict hash/format; cancel/owner guards; symlink denial.');
}finally{for(const directory of [root,other]){assert(directory.startsWith(parent+'\\'));await rm(directory,{recursive:true,force:true});}}

import {createHash,randomUUID} from 'node:crypto';
import {lstat,readFile,mkdir,writeFile,rename,rm,rmdir,realpath} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {parseSkillDocument} from '../harness/skills/registry.js';
import {defaultRole,normalizeRole} from '../../shared/professional-roles.js';
import {withExtensionWriteLock} from '../extension-store-lock.js';
import {saveCommunityMcpServers} from '../extension-library.js';
import {isBuiltinResource} from './builtins.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const strict=(object,keys)=>object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).every(key=>keys.includes(key));
const skillText=(title,data,localId)=>`---\nname: ${localId}\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(data.description)}\nlicense: ${JSON.stringify(data.license)}\nversion: ${JSON.stringify(data.version)}\nauto: false\n---\n${data.instructions}`;
export async function safeRead(root,parts,max=1048576){
  const canonical=await realpath(root);let target=root;
  for(const part of parts){target=join(target,part);const stat=await lstat(target);if(stat.isSymbolicLink())throw Error('COMMUNITY_UNSAFE_RESOURCE');}
  const actual=await realpath(target),inside=relative(canonical,actual),stat=await lstat(target);
  if(inside.startsWith('..')||isAbsolute(inside)||!stat.isFile()||stat.size>max)throw Error('COMMUNITY_UNSAFE_RESOURCE');
  const bytes=await readFile(target);if(bytes.length>max)throw Error('COMMUNITY_RESOURCE_TOO_LARGE');return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
async function directory(root,parts){let target=root;for(const part of parts){target=join(target,part);try{await mkdir(target);}catch(error){if(error.code!=='EEXIST')throw error;}const stat=await lstat(target);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('COMMUNITY_UNSAFE_RESOURCE');}return target;}
async function atomic(root,parts,value){
  const folder=await directory(root,parts.slice(0,-1)),target=join(folder,parts.at(-1)),temporary=join(folder,'.community-'+randomUUID()+'.tmp');
  try{const stat=await lstat(target);if(stat.isSymbolicLink()||!stat.isFile())throw Error('COMMUNITY_UNSAFE_RESOURCE');}catch(error){if(error.code!=='ENOENT')throw error;}
  try{await writeFile(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(temporary,target);}finally{await rm(temporary,{force:true});}
}
export async function readReceiveLog(root){try{const value=JSON.parse(await safeRead(root,['.community','received.json']));if(!strict(value,['version','items'])||value.version!==1||!Array.isArray(value.items)||value.items.length>1000)throw Error('COMMUNITY_LOCAL_READ_FAILED');return value;}catch(error){if(error.code==='ENOENT')return {version:1,items:[]};throw error;}}
async function installedValue(root,receipt,cache=new Map()){
  if(!['skill','mcp','skin','agent'].includes(receipt.kind)||!/^community-[a-f0-9]{32}$/.test(receipt.localId))throw Error('COMMUNITY_INVALID_RESOURCE');
  if(receipt.kind==='skill')return safeRead(root,['skills',receipt.localId,'SKILL.md'],262144);
  const parts=receipt.kind==='mcp'?['aporiax-mcp.json']:receipt.kind==='skin'?['appearance','themes.json']:['security','professional-roles.json'];
  const key=parts.join('/');if(!cache.has(key))cache.set(key,safeRead(root,parts).then(JSON.parse));const value=await cache.get(key);
  if(receipt.kind==='mcp')return JSON.stringify(value.servers.filter(item=>item.id.startsWith(receipt.localId+'-')));
  if(receipt.kind==='skin')return JSON.stringify(value.themes.find(item=>item.id===receipt.themeId)||null);
  return JSON.stringify(value.profiles.find(item=>item.id===receipt.localId)||null);
}
export async function receivedResources(root,owner,apiBaseUrl){
  const scope=hash(apiBaseUrl.replace(/\/+$/,'')+'\n'+owner),log=await readReceiveLog(root),items=[],cache=new Map();
  const latest=new Map(log.items.filter(item=>item.scope===scope).map(item=>[item.id,item]));
  for(const receipt of latest.values()){
    try{
      if(!uuid.test(receipt.id)||!/^[a-f0-9]{64}$/.test(receipt.sha256))continue;
      const installed=await installedValue(root,receipt,cache);
      // Delivery does not forbid later local configuration. Keep edited copies
      // received, and never overwrite them on an idempotent receive retry.
      if(receipt.kind!=='skill'&&(installed==='null'||installed==='[]'))continue;
      if(receipt.kind==='mcp'&&receipt.localMemberIds){
        const present=new Set(JSON.parse(installed).map(item=>item.id));
        if(!receipt.localMemberIds.every(id=>present.has(id)))continue;
      }
      items.push({id:receipt.id,sha256:receipt.sha256,revision:receipt.revision,localStatus:hash(installed)===receipt.storedHash?'saved':'modified'});
    }catch(error){if(!['ENOENT','COMMUNITY_UNSAFE_RESOURCE','COMMUNITY_INVALID_RESOURCE'].includes(error.code||error.message))throw error;}
  }
  return {items};
}
function validate(file){
  if(!strict(file,['id','kind','title','summary','fileName','content','sha256','revision','originId','originRevision','originAuthorId'])||!uuid.test(file.id)||!uuid.test(file.originId)||!uuid.test(file.originAuthorId)||!Number.isInteger(file.originRevision)||file.originRevision<1||!['skill','mcp','skin','agent'].includes(file.kind)||typeof file.title!=='string'||file.title.length<1||file.title.length>80||typeof file.summary!=='string'||file.summary.length>300||typeof file.fileName!=='string'||/[\\/\0]/.test(file.fileName)||typeof file.content!=='string'||Buffer.byteLength(file.content)>262144||file.content.includes('\0')||file.sha256!==hash(file.content)||!Number.isInteger(file.revision)||file.revision<1)throw Error('COMMUNITY_INVALID_RESOURCE');
  if(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)|\bsk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9_.-]{16,}/i.test(file.content))throw Error('COMMUNITY_SECRET_DETECTED');
  if(file.kind==='skill'){
    try{
      const data=parseSkillDocument(file.content,{fallbackName:'community-resource'});
      parseSkillDocument(skillText(file.title,data,'community-'+'0'.repeat(32)));
      return data;
    }catch{throw Error('COMMUNITY_INVALID_RESOURCE');}
  }
  let data;try{data=JSON.parse(file.content);}catch{throw Error('COMMUNITY_INVALID_RESOURCE');}
  if(file.kind==='agent'&&(!strict(data,['name','description','systemPrompt','personality','style','skillIds'])||typeof data.name!=='string'||!data.name.trim()||data.name.length>80||typeof data.systemPrompt!=='string'||!data.systemPrompt.trim()||[data.personality,data.style].some(value=>value!==undefined&&typeof value!=='string')||[data.systemPrompt,data.personality,data.style].filter(Boolean).join('\n\n').length>16000))throw Error('COMMUNITY_INVALID_RESOURCE');
  if(file.kind==='skin'&&!strict(data,['name','base','colors']))throw Error('COMMUNITY_INVALID_RESOURCE');
  if(file.kind==='mcp'){
    if(!strict(data,['mcpServers'])||!data.mcpServers||typeof data.mcpServers!=='object'||Array.isArray(data.mcpServers)||Object.keys(data.mcpServers).length<1||Object.keys(data.mcpServers).length>10)throw Error('COMMUNITY_INVALID_RESOURCE');
    for(const [id,config] of Object.entries(data.mcpServers)){
      if(!strict(config,['command','args','env','headers','url'])||Boolean(config.command)===Boolean(config.url)||isBuiltinResource('mcp',id,config))throw Error('COMMUNITY_INVALID_RESOURCE');
      if(config.args&&(!Array.isArray(config.args)||!config.args.every(item=>typeof item==='string')))throw Error('COMMUNITY_INVALID_RESOURCE');
      for(const values of [config.env,config.headers])if(values&&(!strict(values,Object.keys(values))||!Object.values(values).every(item=>typeof item==='string'&&/^\$\{[A-Z][A-Z0-9_]{0,79}\}$/.test(item))))throw Error('COMMUNITY_INVALID_RESOURCE');
      if(config.url){const url=new URL(config.url);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('COMMUNITY_INVALID_RESOURCE');}
    }
  }
  return data;
}
export function createCommunityReceiver({root,appearanceStore,roleStore}){
  return {
    validate,
    async save(file,owner,apiBaseUrl){
      const data=validate(file),scope=hash(apiBaseUrl.replace(/\/+$/,'')+'\n'+owner),identity=hash(scope+'\n'+file.id+'\n'+file.sha256+'\n'+file.revision),localId='community-'+identity.slice(0,32);
      const existing=(await receivedResources(root,owner,apiBaseUrl)).items.find(item=>item.id===file.id&&item.sha256===file.sha256&&item.revision===file.revision);if(existing)return {...existing,saved:true,unchanged:true};
      const receipt={scope,id:file.id,sha256:file.sha256,revision:file.revision,title:file.title,originId:file.originId,originRevision:file.originRevision,originAuthorId:file.originAuthorId,kind:file.kind,localId,themeId:undefined,storedHash:''};
      let stored;
      if(file.kind==='skill'){
        const text=skillText(file.title,data,localId);
        if(Buffer.byteLength(text)>262144)throw Error('COMMUNITY_RESOURCE_TOO_LARGE');
        await withExtensionWriteLock(root,async canonical=>{
          const parent=await directory(canonical,['skills']);let before;try{before=await safeRead(canonical,['skills',localId,'SKILL.md'],262144);}catch(error){if(error.code!=='ENOENT')throw error;}
          if(before!==undefined){if(before!==text)throw Error('COMMUNITY_LOCAL_CONFLICT');return;}
          let targetExists=false;try{const stat=await lstat(join(parent,localId));if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('COMMUNITY_UNSAFE_RESOURCE');targetExists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
          if(targetExists){const known=(await readReceiveLog(canonical)).items.some(item=>item.scope===scope&&item.id===file.id&&item.sha256===file.sha256&&item.revision===file.revision&&item.localId===localId);if(!known)throw Error('COMMUNITY_LOCAL_CONFLICT');await writeFile(join(parent,localId,'SKILL.md'),text,{flag:'wx',mode:0o600});return;}
          const temporary=await directory(canonical,['skills','.community-'+randomUUID()]);
          try{await writeFile(join(temporary,'SKILL.md'),text,{flag:'wx',mode:0o600});await rename(temporary,join(parent,localId));}catch(error){await rm(join(temporary,'SKILL.md'),{force:true});await rmdir(temporary);throw error;}
        });stored=text;
      }else if(file.kind==='mcp'){
        await directory(root,[]);try{await safeRead(root,['aporiax-mcp.json']);}catch(error){if(error.code!=='ENOENT')throw error;}
        const servers=Object.entries(data.mcpServers).map(([name,config],index)=>({id:localId+'-'+index,name:(file.title+' · '+name).slice(0,80),transport:config.url?'streamable-http':'stdio',enabled:false,autoApproveReadOnly:false,timeoutMs:30000,...config}));
        stored=JSON.stringify(await saveCommunityMcpServers(root,servers));receipt.localMemberIds=servers.map(item=>item.id);
      }else if(file.kind==='skin'){
        const hex=identity.slice(0,32);receipt.themeId='theme-'+[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
        await directory(root,['appearance']);try{await safeRead(root,['appearance','themes.json']);}catch(error){if(error.code!=='ENOENT')throw error;}
        stored=JSON.stringify(await (await appearanceStore()).importCommunity(receipt.themeId,data));
      }else{
        await directory(root,['security']);try{await safeRead(root,['security','professional-roles.json']);}catch(error){if(error.code!=='ENOENT')throw error;}
        const instructions=[data.systemPrompt,data.personality,data.style].filter(Boolean).join('\n\n');
        const profile=normalizeRole({...defaultRole('explore'),id:localId,name:data.name,description:data.description||'',instructions,enabled:false,tools:[],skills:[],mcpTools:[],knowledge:'off'});
        stored=JSON.stringify(await (await roleStore()).importCommunity(profile));
      }
      receipt.storedHash=hash(stored);
      if(hash(await installedValue(root,receipt))!==receipt.storedHash)throw Error('COMMUNITY_LOCAL_VERIFY_FAILED');
      await withExtensionWriteLock(root,async canonical=>{const log=await readReceiveLog(canonical);log.items=log.items.filter(item=>!(item.scope===scope&&item.id===file.id&&item.sha256===file.sha256&&item.revision===file.revision));if(log.items.length>=1000)throw Error('COMMUNITY_LOCAL_LIMIT');log.items.push(receipt);await atomic(canonical,['.community','received.json'],log);});
      return {id:file.id,sha256:file.sha256,revision:file.revision,saved:true,unchanged:false};
    },
  };
}

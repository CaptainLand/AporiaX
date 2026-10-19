import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, win32, posix } from 'node:path';
import { SKILL_NAME } from '../harness/skills/registry.js';
import { validateAppearance } from '../../shared/appearance.js';
import { defaultRoleSettings, normalizeRoleSettings } from '../../shared/professional-roles.js';
import { builtinSkillMetadata, isBuiltinResource } from './builtins.js';
import { readReceiveLog, receivedResources } from './receive.js';

const MAX=262144;
const digest=value=>createHash('sha256').update(value).digest('hex');
const secret=/-----BEGIN (?:[A-Z ]*PRIVATE KEY)|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}\b|Bearer\s+[A-Za-z0-9_.-]{16,}/i;
const privatePath=/(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>]*|\/(?:Users|home|tmp|private|var)\/[^\s"'<>]*)/g;
const portable=value=>String(value||'').replace(privatePath,'${LOCAL_PATH}');
const displayTitle=value=>{const title=portable(value).slice(0,80);return secret.test(title)?'资源（敏感名称已隐藏）':title;};
async function readSafe(root,file,max=MAX){
  const base=await realpath(root),resolved=await realpath(file);
  const inside=relative(base,resolved);
  if(inside.startsWith('..')||isAbsolute(inside))throw Error('COMMUNITY_UNSAFE_RESOURCE');
  const parts=relative(root,file).split(/[\\/]/);let cursor=root;
  for(const part of parts){cursor=join(cursor,part);if((await lstat(cursor)).isSymbolicLink())throw Error('COMMUNITY_UNSAFE_RESOURCE');}
  const stat=await lstat(file);
  if(!stat.isFile()||stat.size>max)throw Error('COMMUNITY_RESOURCE_TOO_LARGE');
  const bytes=await readFile(file),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(bytes.length>max||text.includes('\0'))throw Error('COMMUNITY_INVALID_RESOURCE');
  return text;
}
async function json(root,file,max=1048576){try{return JSON.parse(await readSafe(root,file,max));}catch(error){if(error.code==='ENOENT')return null;throw error;}}

// Read only application-managed stores. Never enumerate project files, resolve
// environment values, probe an MCP, run a script, or accept a renderer path.
export async function localResourceCatalog(userDataDirectory){
  const items=(await builtinSkillMetadata()).map(item=>({...item}));
  let directories=[];
  try{directories=await readdir(join(userDataDirectory,'skills'),{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const entry of directories.filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()&&SKILL_NAME.test(entry.name)).slice(0,200)){
    const id='skill:'+entry.name;if(!items.some(item=>item.id===id))items.push({id,kind:'skill',title:entry.name,summary:'Skill 主文档快照',scope:'SKILL.md；不包含脚本与附件'});
  }
  const mcp=await json(userDataDirectory,join(userDataDirectory,'aporiax-mcp.json'));
  for(const item of (mcp?.servers||[]).slice(0,64)){
    if(typeof item.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(item.id))continue;
    let name=String(item.name||item.id);for(const value of Object.values({...item.env,...item.headers})){if(typeof value==='string'&&value.length>=4&&!/^\$\{[A-Z0-9_]+\}$/.test(value))name=name.split(value).join('已隐藏');}
    items.push({id:'mcp:'+item.id,kind:'mcp',title:displayTitle(name),summary:'MCP 可移植配置快照',scope:'凭据替换为变量；本机路径不上传',builtin:isBuiltinResource('mcp',item.id,item)});
  }
  const appearance=await json(userDataDirectory,join(userDataDirectory,'appearance','themes.json'));
  if(appearance)for(const item of validateAppearance(appearance).themes)items.push({id:'skin:'+item.id,kind:'skin',title:portable(item.name),summary:'基础配色快照',scope:'仅基础四色；不包含背景图片'});
  const roles=await json(userDataDirectory,join(userDataDirectory,'security','professional-roles.json'))||defaultRoleSettings();
  for(const item of normalizeRoleSettings(roles).profiles)items.push({id:'agent:'+item.id,kind:'agent',title:portable(item.name),summary:portable(item.description).slice(0,300)||'Agent 角色快照',scope:'角色指令；不包含模型密钥、权限和项目知识'});
  const importedMetadata=new Map((await readReceiveLog(userDataDirectory)).items.map(item=>[item.kind+':'+(item.kind==='skin'?item.themeId:item.kind==='mcp'?item.localId+'-0':item.localId),item]));
  return items.map(item=>{const builtin=item.builtin===true||isBuiltinResource(item.kind,item.id.slice(item.id.indexOf(':')+1)),imported=importedMetadata.has(item.id)||item.id.split(':')[1]?.startsWith('community-');return {...item,title:displayTitle(importedMetadata.get(item.id)?.title||item.title),builtin,imported,uploadable:!builtin&&!imported};});
}

export async function exportLocalResource(userDataDirectory,id){
  const catalog=await localResourceCatalog(userDataDirectory),item=catalog.find(item=>item.id===id);
  if(!item)throw Error('COMMUNITY_LOCAL_RESOURCE_NOT_FOUND');
  if(!item.uploadable)throw Error(item.imported?'COMMUNITY_IMPORTED_RESOURCE':'COMMUNITY_BUILTIN_RESOURCE');
  const key=id.slice(id.indexOf(':')+1),warnings=[item.scope];let content,fileName;
  if(item.kind==='skill'){
    const directory=join(userDataDirectory,'skills',key);
    const raw=await readSafe(userDataDirectory,join(directory,'SKILL.md'));
    const extras=(await readdir(directory)).filter(name=>name!=='SKILL.md');
    if(extras.length)throw Error('COMMUNITY_SKILL_PACKAGE_NOT_SUPPORTED: 此 Skill 含脚本或附件，当前不能完整同步；未上传任何内容。');
    content=portable(raw);fileName='SKILL.md';
  }else if(item.kind==='mcp'){
    const source=(await json(userDataDirectory,join(userDataDirectory,'aporiax-mcp.json'))).servers.find(server=>server.id===key);
    const privateValues=Object.values({...source.env,...source.headers}).filter(value=>typeof value==='string'&&value.length>=4&&!/^\$\{[A-Z0-9_]+\}$/.test(value)).flatMap(value=>[value,...(/^Bearer /i.test(value)?[value.slice(7)]:[])]);
    const scrub=value=>{let text=portable(value);for(const privateValue of privateValues)text=text.split(privateValue).join('${REDACTED}');return text;};
    const config={};
    if(!source.transport||source.transport==='stdio'){
      const command=String(source.command||'');config.command=/[\\/]/.test(command)?win32.basename(posix.basename(command)):command;
      let redactNext=false;
      config.args=(source.args||[]).map(value=>{
        const text=String(value);
        if(redactNext){redactNext=false;return '${REDACTED}';}
        if(/^--?(?:api[-_]?key|token|secret|password|authorization)$/i.test(text)){redactNext=true;return text;}
        if(/^--?(?:api[-_]?key|token|secret|password|authorization)=/i.test(text))return text.slice(0,text.indexOf('=')+1)+'${REDACTED}';
        if(/^https?:\/\//i.test(text)){const url=new URL(text);url.username='';url.password='';url.search='';url.hash='';return scrub(url.toString());}
        return scrub(text);
      });
      if(source.env)config.env=Object.fromEntries(Object.keys(source.env).filter(name=>/^[A-Z][A-Z0-9_]{0,79}$/.test(name)).map(name=>[name,'${'+name+'}']));
    }else{
      const url=new URL(String(source.url||''));
      url.username='';url.password='';url.search='';url.hash='';
      config.url=scrub(url.toString());
      if(source.headers)config.headers=Object.fromEntries(Object.keys(source.headers).map(name=>[name,'${MCP_HEADER_'+name.toUpperCase().replace(/[^A-Z0-9_]/g,'_').slice(0,60)+'}']));
    }
    content=JSON.stringify({mcpServers:{[key]:config}},null,2);fileName='mcp.json';
    warnings.push('环境变量和请求头值已移除；工作目录已移除；URL 查询参数已移除。');
  }else if(item.kind==='skin'){
    const source=validateAppearance(await json(userDataDirectory,join(userDataDirectory,'appearance','themes.json'))).themes.find(theme=>theme.id===key);
    content=JSON.stringify({name:portable(source.name),base:source.base,colors:Object.fromEntries(['accent','background','panel','text'].map(name=>[name,source.colors[name]]))},null,2);fileName='theme.json';
  }else{
    const source=normalizeRoleSettings(await json(userDataDirectory,join(userDataDirectory,'security','professional-roles.json'))||defaultRoleSettings()).profiles.find(profile=>profile.id===key);
    content=JSON.stringify({name:portable(source.name),description:portable(source.description),systemPrompt:portable(source.instructions||source.description||source.name),skillIds:source.skills.filter(name=>/^[a-zA-Z0-9_-]{1,80}$/.test(name))},null,2);fileName='agent.json';
  }
  if(Buffer.byteLength(content,'utf8')>MAX)throw Error('COMMUNITY_RESOURCE_TOO_LARGE');
  if(secret.test(content+'\n'+item.title+'\n'+item.summary))throw Error('COMMUNITY_SECRET_DETECTED: 发现疑似密钥，未上传。');
  return {sourceKey:item.kind+':'+digest(id),kind:item.kind,title:item.title.slice(0,80),summary:item.summary,fileName,content,warnings};
}

export function createLocalRepositorySync({userDataDirectory,account,confirm,confirmReceive,receiver}){
  let busy=false;
  const identity=async input=>{const current=await account.getSnapshot();if(current.status!=='authenticated'||!current.profile?.id)throw Error('DESKTOP_ACCOUNT_SIGNED_OUT');if(current.profile.id!==input.accountId)throw Error('COMMUNITY_ACCOUNT_CHANGED');if(String(input.apiBaseUrl).replace(/\/+$/,'')!==account.apiBaseUrl.replace(/\/+$/,''))throw Error('COMMUNITY_SERVICE_MISMATCH');return current;};
  return {
    async received(input){await identity(input);const result=await receivedResources(userDataDirectory,input.accountId,input.apiBaseUrl);await identity(input);return result;},
    async pull(input){
      if(busy)throw Error('COMMUNITY_SYNC_BUSY');busy=true;
      try{
        if(!receiver||!confirmReceive)throw Error('COMMUNITY_CLIENT_UPDATE_REQUIRED');
        if(!input||Object.keys(input).some(key=>!['accountId','apiBaseUrl','id','sha256','revision'].includes(key))||!/^[a-f0-9-]{36}$/i.test(input.id)||!/^[a-f0-9]{64}$/.test(input.sha256)||!Number.isInteger(input.revision)||input.revision<1)throw Error('COMMUNITY_INVALID_REQUEST');
        const current=await identity(input),file=await account.communityRepositoryRequest('content',{id:input.id},input.accountId);await identity(input);
        if(file.id!==input.id||file.sha256!==input.sha256||file.revision!==input.revision)throw Error('COMMUNITY_REPOSITORY_CONFLICT');receiver.validate(file);
        const previous=(await this.received(input)).items.find(item=>item.id===file.id&&item.sha256===file.sha256&&item.revision===file.revision);if(previous)return {...previous,saved:true,unchanged:true};
        if(!await confirmReceive({title:file.title,kind:file.kind,accountName:current.profile.displayName||current.profile.email,revision:file.originRevision,sha256:file.sha256}))return {canceled:true,saved:false};
        await identity(input);const result=await receiver.save(file,input.accountId,input.apiBaseUrl);await identity(input);return result;
      }finally{busy=false;}
    },
    async detectAll({accountId,apiBaseUrl}){
      const current=await account.getSnapshot();
      if(current.status!=='authenticated'||!current.profile?.id)throw Error('DESKTOP_ACCOUNT_SIGNED_OUT');
      if(current.profile.id!==accountId)throw Error('COMMUNITY_ACCOUNT_CHANGED');
      if(String(apiBaseUrl).replace(/\/+$/,'')!==account.apiBaseUrl.replace(/\/+$/,''))throw Error('COMMUNITY_SERVICE_MISMATCH');
      const items=await localResourceCatalog(userDataDirectory);
      return {total:items.length,eligibleTotal:items.filter(item=>item.uploadable).length,builtinTotal:items.filter(item=>item.builtin).length,importedTotal:items.filter(item=>item.imported&&!item.builtin).length,counts:Object.fromEntries(['skill','mcp','skin','agent'].map(kind=>[kind,items.filter(item=>item.kind===kind).length])),resources:items.map(({kind,title,builtin,imported,uploadable})=>({kind,title,builtin,imported,uploadable}))};
    },
    async syncAll(input){
      if(busy)throw Error('COMMUNITY_SYNC_BUSY');
      busy=true;
      try{
        const detected=await this.detectAll(input),current=await account.getSnapshot(),owner=current.profile?.id;
        if(owner!==input.accountId)throw Error('COMMUNITY_ACCOUNT_CHANGED');
        const files=[],skipped=[],excluded=[];
        for(const item of await localResourceCatalog(userDataDirectory)){
          if(!item.uploadable){excluded.push({title:item.title,kind:item.kind,code:item.imported?'COMMUNITY_IMPORTED_RESOURCE':'COMMUNITY_BUILTIN_RESOURCE'});continue;}
          try{files.push(await exportLocalResource(userDataDirectory,item.id));}
          catch(error){skipped.push({title:item.title,code:String(error.message).split(':')[0]});}
        }
        const totals={total:detected.total,eligibleTotal:detected.eligibleTotal,excluded};
        if(!files.length)return {uploaded:0,...totals,skipped,complete:skipped.length===0};
        const remote=[];
        for(let page=0;page<5;page++){const result=await account.communityRepositoryRequest('list',{page},owner);remote.push(...result.items);if(!result.hasMore)break;}
        if(new Set([...remote.map(item=>item.source_key),...files.map(item=>item.sourceKey)]).size>100)throw Error('COMMUNITY_REPOSITORY_FULL');
        const accepted=await confirm({accountName:current.profile.displayName||current.profile.email,accountId:owner,destination:new URL(account.apiBaseUrl).origin,items:files.map(({title,kind,warnings})=>({title,kind,warnings})),skipped});
        if(!accepted)return {canceled:true,uploaded:0,...totals,skipped};
        let uploaded=0;
        for(let offset=0;offset<files.length;offset+=5){
          const check=await account.getSnapshot();
          if(check.profile?.id!==owner||check.status!=='authenticated')return {uploaded,...totals,skipped,complete:false,error:'COMMUNITY_ACCOUNT_CHANGED'};
          const entries=files.slice(offset,offset+5).map(({warnings,...file})=>{const previous=remote.find(row=>row.source_key===file.sourceKey);return {...file,...(previous?{expectedSha:previous.sha256,expectedRevision:previous.revision}:{})};});
          try{const result=await account.communityRepositoryRequest('sync',{consent:true,entries},owner);uploaded+=result.items.length;}
          catch(error){return {uploaded,...totals,skipped,complete:false,error:String(error.message).split(':')[0]};}
        }
        return {uploaded,...totals,skipped,complete:skipped.length===0};
      }finally{busy=false;}
    },
    async list(){const current=await account.getSnapshot();return {items:await localResourceCatalog(userDataDirectory),account:{id:current.profile?.id||'',name:current.profile?.displayName||current.profile?.email||'',status:current.status},cloudSyncDefault:false};},
    async sync(input){
      if(busy)throw Error('COMMUNITY_SYNC_BUSY');
      if(!input||Object.keys(input).some(key=>key!=='ids')||!Array.isArray(input.ids)||input.ids.length<1||input.ids.length>5||new Set(input.ids).size!==input.ids.length)throw Error('COMMUNITY_INVALID_SELECTION');
      busy=true;
      try{
        const current=await account.getSnapshot(),owner=current.profile?.id;
        if(current.status!=='authenticated'||!owner)throw Error('DESKTOP_ACCOUNT_SIGNED_OUT');
        const files=await Promise.all(input.ids.map(id=>exportLocalResource(userDataDirectory,id)));
        const remote=[];let page=0;
        while(page<5){const result=await account.communityRepositoryRequest('list',{page},owner);remote.push(...result.items);if(!result.hasMore)break;page++;}
        const accepted=await confirm({accountName:current.profile.displayName||current.profile.email,accountId:owner,destination:new URL(account.apiBaseUrl).origin,items:files.map(({title,kind,warnings})=>({title,kind,warnings}))});
        if(!accepted)return {canceled:true,uploaded:0};
        const check=await account.getSnapshot();if(check.profile?.id!==owner||check.status!=='authenticated')throw Error('COMMUNITY_ACCOUNT_CHANGED');
        const entries=files.map(({warnings,...file})=>{const previous=remote.find(row=>row.source_key===file.sourceKey);return {...file,...(previous?{expectedSha:previous.sha256,expectedRevision:previous.revision}:{})};});
        const result=await account.communityRepositoryRequest('sync',{consent:true,entries},owner);
        return {...result,uploaded:result.items.length,warnings:files.flatMap(file=>file.warnings)};
      }finally{busy=false;}
    },
  };
}

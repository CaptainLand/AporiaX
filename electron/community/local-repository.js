import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, win32, posix } from 'node:path';
import { SKILL_NAME } from '../harness/skills/registry.js';
import { validateAppearance } from '../../shared/appearance.js';
import { defaultRoleSettings, normalizeRoleSettings } from '../../shared/professional-roles.js';
import { builtinSkillMetadata, isBuiltinResource } from './builtins.js';
import { readReceiveLog, receivedResources } from './receive.js';
import { communityMarketCatalog, marketCount, marketHasDuplicate, marketItem, marketLocalResourceId, marketManageSelection, marketMySubmission, marketQuota, marketSelection, marketSubmission } from './market.js';

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
export async function localResourceCatalog(userDataDirectory,{kind}={}){
  const items=[];
  if(!kind||kind==='skill'){
    items.push(...(await builtinSkillMetadata()).map(item=>({...item})));
    let directories=[];
    try{directories=await readdir(join(userDataDirectory,'skills'),{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')throw error;}
    for(const entry of directories.filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()&&SKILL_NAME.test(entry.name)).slice(0,200)){
      const id='skill:'+entry.name;if(!items.some(item=>item.id===id))items.push({id,kind:'skill',title:entry.name,summary:'Skill 主文档快照',scope:'SKILL.md；不包含脚本与附件'});
    }
  }
  if(!kind||kind==='mcp'){
    const mcp=await json(userDataDirectory,join(userDataDirectory,'aporiax-mcp.json'));
    for(const item of (mcp?.servers||[]).slice(0,64)){
      if(typeof item.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(item.id))continue;
      let name=String(item.name||item.id);for(const value of Object.values({...item.env,...item.headers})){if(typeof value==='string'&&value.length>=4&&!/^\$\{[A-Z0-9_]+\}$/.test(value))name=name.split(value).join('已隐藏');}
      items.push({id:'mcp:'+item.id,kind:'mcp',title:displayTitle(name),summary:'MCP 可移植配置快照',scope:'凭据替换为变量；本机路径不上传',builtin:isBuiltinResource('mcp',item.id,item)});
    }
  }
  if(!kind||kind==='skin'){
    const appearance=await json(userDataDirectory,join(userDataDirectory,'appearance','themes.json'));
    if(appearance)for(const item of validateAppearance(appearance).themes)items.push({id:'skin:'+item.id,kind:'skin',title:portable(item.name),
      summary:`一款${item.base==='dark'?'深色':'浅色'}界面主题，添加后可在「个性化」中切换。`,scope:'仅基础四色；不包含背景图片'});
  }
  if(!kind||kind==='agent'){
    const roles=await json(userDataDirectory,join(userDataDirectory,'security','professional-roles.json'))||defaultRoleSettings();
    for(const item of normalizeRoleSettings(roles).profiles)items.push({id:'agent:'+item.id,kind:'agent',title:portable(item.name),summary:portable(item.description).slice(0,300)||'Agent 角色快照',scope:'角色指令；不包含模型密钥、权限和项目知识'});
  }
  const importedMetadata=new Map((await readReceiveLog(userDataDirectory)).items.map(item=>[item.kind+':'+(item.kind==='skin'?item.themeId:item.kind==='mcp'?item.localId+'-0':item.localId),item]));
  return items.map(item=>{const builtin=item.builtin===true||isBuiltinResource(item.kind,item.id.slice(item.id.indexOf(':')+1)),imported=importedMetadata.has(item.id)||item.id.split(':')[1]?.startsWith('community-');return {...item,title:displayTitle(importedMetadata.get(item.id)?.title||item.title),builtin,imported,uploadable:!builtin&&!imported};});
}

export async function exportLocalResource(userDataDirectory,id){
  const catalog=await localResourceCatalog(userDataDirectory),item=catalog.find(item=>item.id===id);
  if(!item)throw Error('COMMUNITY_LOCAL_RESOURCE_NOT_FOUND');
  if(!item.uploadable)throw Error(item.imported?'COMMUNITY_IMPORTED_RESOURCE':'COMMUNITY_BUILTIN_RESOURCE');
  return exportCatalogResource(userDataDirectory,item);
}
async function exportCatalogResource(userDataDirectory,item){
  const {id}=item;
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

async function hasMatchingLocalExport(root,item){
  const candidates=(await localResourceCatalog(root,{kind:item.kind})).filter(entry=>entry.uploadable);
  for(const candidate of candidates){
    try{
      const local=await exportCatalogResource(root,candidate);
      if(digest(local.content)===item.sha256)return true;
    }catch{
      // An unreadable or non-portable entry is not evidence of a match.
    }
  }
  return false;
}

export function createLocalRepositorySync({userDataDirectory,account,confirm,confirmReceive,confirmSubmissionAction,receiver}){
  let busy=false;
  const marketAttempts=new Map();
  const identity=async input=>{const current=await account.getSnapshot();if(current.status!=='authenticated'||!current.profile?.id)throw Error('DESKTOP_ACCOUNT_SIGNED_OUT');if(current.profile.id!==input.accountId)throw Error('COMMUNITY_ACCOUNT_CHANGED');if(String(input.apiBaseUrl).replace(/\/+$/,'')!==account.apiBaseUrl.replace(/\/+$/,''))throw Error('COMMUNITY_SERVICE_MISMATCH');return current;};
  const marketSession=async accountId=>{
    const scope={accountId,apiBaseUrl:account.apiBaseUrl},current=await identity(scope);
    const guard=account.communitySessionGuard(accountId);
    const request=async(action,input)=>{guard();return account.communityRepositoryRequest(action,input,accountId);};
    const installed=()=>receivedResources(userDataDirectory,accountId,scope.apiBaseUrl,{includeOrigin:true});
    return {scope,current,guard,request,installed};
  };
  const uploadFile=async id=>{
    if(!marketLocalResourceId(id))throw Error('COMMUNITY_INVALID_UPLOAD');
    const file=await exportLocalResource(userDataDirectory,id);
    return {file,fingerprint:digest(JSON.stringify([file.kind,file.fileName,file.content]))};
  };
  const checkMarketRules=me=>{
    if(me?.rules?.accepted!==true||typeof me.rules.revision!=='string'||!me.rules.revision)throw Error('COMMUNITY_RULES_REQUIRED');
  };
  const localMatch=async(item,installed)=>{
    const {items}=await installed();
    if(items.some(entry=>entry.originId===item.id&&entry.originRevision===item.revision&&entry.sha256===item.sha256))return 'received';
    if(items.some(entry=>entry.kind===item.kind&&entry.sha256===item.sha256&&entry.localStatus==='saved'))return 'matching';
    return await hasMatchingLocalExport(userDataDirectory,item)?'matching':'';
  };
  const alreadySaved=(match,downloadCount)=>({
    saved:true,unchanged:true,downloadCount,...(match==='matching'?{localMatch:true}:{}),
  });
  return {
    async marketCatalog(accountId){
      const {guard,request,installed}=await marketSession(accountId);
      const [items,me,local]=await Promise.all([communityMarketCatalog(request),request('marketRules'),installed()]);
      guard();
      const saved=new Set(local.items.map(item=>[item.originId,item.originRevision,item.sha256].join(':')));
      const localContents=new Set(local.items.filter(item=>item.localStatus==='saved').map(item=>item.kind+':'+item.sha256));
      return {rulesAccepted:me?.rules?.accepted===true,quota:marketQuota(me?.quota),items:items.map(item=>{
        const received=saved.has([item.id,item.revision,item.sha256].join(':'));
        const matching=!received&&localContents.has(item.kind+':'+item.sha256);
        return {...item,added:received||matching,...(matching?{localMatch:true}:{})};
      })};
    },
    async marketUploadOptions(accountId){
      const {guard,request}=await marketSession(accountId);
      const me=await request('marketRules');checkMarketRules(me);
      const items=(await localResourceCatalog(userDataDirectory)).filter(item=>item.uploadable)
        .map(({id,kind,title})=>({id,kind,title}));
      guard();
      return {items,quota:marketQuota(me?.quota)};
    },
    async marketUploadPreview(input){
      if(!input||Object.keys(input).some(key=>!['accountId','id'].includes(key)))throw Error('COMMUNITY_INVALID_UPLOAD');
      const {guard,request}=await marketSession(input.accountId);
      checkMarketRules(await request('marketRules'));
      const {file,fingerprint}=await uploadFile(input.id);guard();
      const duplicate=await marketHasDuplicate(request,file.kind,digest(file.content));guard();
      // Read from app-owned stores only. Return the exact scrubbed payload for author review.
      const {kind,title,summary,fileName,content,warnings}=file;
      return {id:input.id,kind,title,summary,fileName,content,warnings,fingerprint,duplicate};
    },
    async marketSubmit(input){
      if(busy)throw Error('COMMUNITY_SYNC_BUSY');busy=true;
      try{
        const selection=marketSubmission(input);
        const {guard,request}=await marketSession(selection.accountId),me=await request('marketRules');
        checkMarketRules(me);
        const {file,fingerprint}=await uploadFile(selection.id);guard();
        if(fingerprint!==selection.fingerprint)throw Error('COMMUNITY_UPLOAD_SOURCE_CHANGED');
        const {kind,fileName,content}=file;
        const attemptKey=selection.accountId+':'+selection.key;
        const attemptHash=digest(JSON.stringify([fingerprint,selection.title,selection.summary,selection.downloadAllowed,me.rules.revision]));
        const prior=marketAttempts.get(attemptKey);
        if(prior&&prior!==attemptHash)throw Error('COMMUNITY_IDEMPOTENCY_CONFLICT');
        if(!prior&&await marketHasDuplicate(request,kind,digest(content)))throw Error('COMMUNITY_DUPLICATE_SUBMISSION');
        guard();
        if(!prior){
          if(marketAttempts.size>=256)marketAttempts.delete(marketAttempts.keys().next().value);
          marketAttempts.set(attemptKey,attemptHash);
        }
        // The server is authoritative for quota, and checks the idempotency key
        // before quota; a lost response can be retried even on the last credit.
        const result=await request('marketSubmit',{key:selection.key,kind,fileName,content,
          title:selection.title,summary:selection.summary,consent:true,rulesRevision:me.rules.revision,
          downloadAllowed:selection.downloadAllowed});
        guard();
        if(typeof result?.submission?.id!=='string')throw Error('COMMUNITY_MARKET_UNAVAILABLE');
        return {status:result.submission.status,quota:marketQuota(result.quota)};
      }finally{busy=false;}
    },
    async marketMine(input){
      if(!input||Object.keys(input).some(key=>!['accountId','page'].includes(key))
        ||!Number.isSafeInteger(input.page)||input.page<0||input.page>=100)throw Error('COMMUNITY_INVALID_REQUEST');
      const {request,guard}=await marketSession(input.accountId);
      const result=await request('marketMine',{page:input.page});guard();
      if(!Array.isArray(result?.items)||typeof result.hasMore!=='boolean')throw Error('COMMUNITY_CATALOG_INVALID');
      return {items:result.items.map(row=>marketMySubmission(row,input.accountId)),hasMore:result.hasMore&&input.page<99};
    },
    async marketManage(input){
      if(busy)throw Error('COMMUNITY_SYNC_BUSY');busy=true;
      try{
        if(!confirmSubmissionAction)throw Error('COMMUNITY_CLIENT_UPDATE_REQUIRED');
        const selected=marketManageSelection(input);
        const {request,guard}=await marketSession(selected.accountId);
        const detail=marketMySubmission(await request('marketSubmissionDetail',{id:selected.id}),selected.accountId);
        guard();
        if(detail.id!==selected.id||detail.revision!==selected.revision||
          (selected.action==='unpublish'
            ? (detail.publication?.revision!==selected.publishedRevision||detail.publication.visibility!=='published')
            : !['pending','returned'].includes(detail.status)))throw Error('COMMUNITY_REVISION_CONFLICT');
        if(!await confirmSubmissionAction({title:detail.title,action:selected.action,id:detail.id}))return {canceled:true};
        guard();
        const result=await request('marketManage',selected);guard();
        if(result?.id!==selected.id)throw Error('COMMUNITY_MARKET_UNAVAILABLE');
        return {changed:true};
      }finally{busy=false;}
    },
    async marketAdd(input){
      if(busy)throw Error('COMMUNITY_SYNC_BUSY');busy=true;
      try{
        if(!receiver||!confirmReceive)throw Error('COMMUNITY_CLIENT_UPDATE_REQUIRED');
        const selected=marketSelection(input);
        const {scope,current,guard,request,installed}=await marketSession(selected.accountId);
        const [catalog,me]=await Promise.all([request('marketCatalog',{kind:selected.kind,page:0,id:selected.id}),request('marketRules')]);
        guard();
        if(me?.rules?.accepted!==true)throw Error('COMMUNITY_RULES_REQUIRED');
        const row=catalog?.items?.find(item=>item.id===selected.id);
        if(!row)throw Error('COMMUNITY_NOT_FOUND');
        const item=marketItem(row,selected.kind);
        if(!item.downloadAllowed)throw Error('COMMUNITY_DOWNLOAD_PERMISSION_REQUIRED');
        if(item.sha256!==selected.sha256||item.revision!==selected.revision)throw Error('COMMUNITY_REPOSITORY_CONFLICT');
        const match=await localMatch(item,installed);guard();
        if(match)return alreadySaved(match,item.downloadCount);
        if(!await confirmReceive({title:item.title,kind:item.kind,revision:item.revision,sha256:item.sha256,
          accountName:current.profile.displayName||current.profile.email,market:true}))return {canceled:true};
        guard();
        // The existing import endpoint atomically checks listing visibility, download permission, and the exact revision.
        const imported=await request('marketImport',item);
        const file=await request('content',{id:imported?.id});
        guard();
        if(file?.id!==imported?.id||file?.originId!==item.id||file?.originRevision!==item.revision
          ||file?.sha256!==item.sha256||file?.kind!==item.kind)throw Error('COMMUNITY_REPOSITORY_CONFLICT');
        receiver.validate(file);guard();
        // The user could have created or synced the matching local resource
        // while the confirmation or the network request was open.
        const lateMatch=await localMatch(item,installed);guard();
        if(lateMatch)return alreadySaved(lateMatch,marketCount(imported.downloadCount)??item.downloadCount);
        const result=await receiver.save(file,scope.accountId,scope.apiBaseUrl);
        guard();
        return {saved:result.saved===true,unchanged:result.unchanged===true,
          downloadCount:marketCount(imported.downloadCount)??item.downloadCount};
      }finally{busy=false;}
    },
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

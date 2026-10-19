import { readFile } from 'node:fs/promises';
import { createSkillRegistry } from '../harness/skills/registry.js';
import { BUNDLED_OFFICE_SKILLS } from '../harness/skills/bundled-office-skills.js';

const manifest=JSON.parse(await readFile(new URL('../../shared/community-builtins.json',import.meta.url),'utf8'));
export function isBuiltinResource(kind,id,config={}) {
  if(manifest[kind]?.includes(id))return true;
  if(kind!=='mcp')return false;
  const args=[config.command,...(Array.isArray(config.args)?config.args:[])].filter(value=>typeof value==='string');
  let endpoint='';try{const url=new URL(String(config.url||''));url.search='';url.hash='';url.username='';url.password='';endpoint=url.toString().replace(/\/$/,'');}catch{/* Stdio configurations have no URL. */}
  return args.some(value=>manifest.mcpPackages.some(pkg=>value===pkg||value.startsWith(pkg+'@')))
    || manifest.mcpUrls.includes(endpoint);
}
let metadata;
export function builtinSkillMetadata(){
  return metadata||=(async()=>{
  const skills=await createSkillRegistry().catalog();
  return [...skills,...BUNDLED_OFFICE_SKILLS].map(({name,title})=>({id:'skill:'+name,kind:'skill',title:title||name,summary:'AporiaX 自带 Skill',scope:'内置资源，仅检测，不上传',builtin:true,uploadable:false}));
  })().catch(error=>{metadata=null;throw error;});
}

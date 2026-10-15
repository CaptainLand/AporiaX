import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only release handoff check. Never copies a stale candidate over dev work.
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await readFile(resolve(workspace,'specs/cloud-usage-reliability/source-manifest.json'),'utf8'));
const overrides={};
for(let i=2;i<process.argv.length;i+=2){
  const match=process.argv[i].match(/^--(desktop|cloud|web)-root$/);
  if(!match||!process.argv[i+1])throw new Error('Use --desktop-root PATH, --cloud-root PATH or --web-root PATH');
  overrides[match[1]]=resolve(process.argv[i+1]);
}
let checked=0,failed=0;
for(const [name,project] of Object.entries(manifest.projects)){
  const root=overrides[name]||resolve(workspace,project.root);
  for(const file of project.files){
    if(isAbsolute(file.path)||file.path.split(/[\\/]/).includes('..'))throw new Error('Invalid manifest path');
    try {
      const source=(await readFile(resolve(root,file.path),'utf8')).replace(/\r\n/g,'\n');
      const hash=createHash('sha256').update(source).digest('hex');checked++;
      if(hash!==file.sha256){failed++;console.error(`SOURCE_MISMATCH ${name}/${file.path}`);}
    } catch(error){failed++;console.error(`SOURCE_UNAVAILABLE ${name}/${file.path}: ${error.code||error.message}`);}
  }
}
console.log(`Source handoff: ${checked} checked, ${failed} mismatched/missing (SHA-256, normalized LF).`);
if(failed)process.exitCode=1;

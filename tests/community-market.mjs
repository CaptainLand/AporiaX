import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { communityMarketRequest } from '../electron/community/market.js';
import { createLocalRepositorySync } from '../electron/community/local-repository.js';
import { createCommunityReceiver, readReceiveLog } from '../electron/community/receive.js';

const root=await mkdtemp(join(tmpdir(),'aporia-market-'));
try {
  const owner=randomUUID(), origin=randomUUID(), repoId=randomUUID(), author=randomUUID(), content='# Market fixture\nSummarize the changes.';
  const sha256=createHash('sha256').update(content).digest('hex');
  const version={accountId:owner,id:origin,kind:'skill',revision:1,sha256};
  const row={...version,title:'Skill fixture',summary:'Test',author_id:owner,download_allowed:true,download_count:'7',content:'Must not leak'};
  const denied={...row,id:randomUUID(),title:'Display only',download_allowed:false};
  const otherPublication={...row,id:randomUUID()};
  const remoteFile={id:repoId,kind:'skill',title:row.title,summary:row.summary,fileName:'SKILL.md',content,sha256,
    revision:3,originId:origin,originRevision:1,originAuthorId:author};
  let signedIn=false, rules=false, epoch=0, allowed=false, changeSession=false, wrongContent=false, writes=0;
  let mine=[], manageAllowed=false, foreign=false, manages=0, includeOther=false, confirmations=0;
  const quota={limit:3,remaining:2,resetsAt:'2026-11-29T16:00:00.000Z'};
  const calls=[];
  const account={
    apiBaseUrl:'https://cloud.example.invalid',
    getSnapshot:async()=>signedIn?{status:'authenticated',profile:{id:owner,displayName:'Fixture'}}:{status:'anonymous'},
    communitySessionGuard(accountId){
      const start=epoch;
      const guard=()=>{if(!signedIn||accountId!==owner||epoch!==start)throw Error('COMMUNITY_ACCOUNT_CHANGED');};
      guard();return guard;
    },
    async communityRepositoryRequest(action,input,accountId){
      assert.equal(accountId,owner);calls.push([action,input]);
      if(action==='marketRules')return {rules:{accepted:rules,revision:'2026-10-19.3'},quota};
      if(action==='marketMine')return {items:mine,hasMore:false};
      if(action==='marketSubmissionDetail')return {...mine.find(item=>item.id===input.id),...(foreign?{owner_id:randomUUID()}:{})};
      if(action==='marketManage'){manages++;return {id:input.id};}
      if(action==='marketCatalog')return input.kind!=='skill'?{items:[],hasMore:false}
        : input.id?{items:[row,denied,otherPublication].filter(item=>item.id===input.id),hasMore:false}
          : input.page===0?{items:[row],hasMore:true}:{items:[denied,...(includeOther?[otherPublication]:[])],hasMore:false};
      if(action==='marketImport'){writes++;return {id:repoId,downloadCount:'8'};}
      if(action==='content')return wrongContent?{...remoteFile,originId:randomUUID()}:remoteFile;
      if(action==='marketSubmit')return {submission:{id:randomUUID(),status:'pending'},quota:{...quota,remaining:1}};
    },
  };
  const repo=createLocalRepositorySync({userDataDirectory:root,account,receiver:createCommunityReceiver({root}),
    confirmSubmissionAction:async()=>{if(changeSession)epoch++;return manageAllowed;},
    confirmReceive:async info=>{confirmations++;assert.equal(info.market,true);if(changeSession)epoch++;return allowed;}});
  await assert.rejects(repo.marketCatalog(owner),/DESKTOP_ACCOUNT_SIGNED_OUT/);
  assert.equal(calls.length,0);
  signedIn=true;
  await assert.rejects(repo.marketCatalog(randomUUID()),/COMMUNITY_ACCOUNT_CHANGED/);
  const initial=await repo.marketCatalog(owner);
  assert.equal(initial.rulesAccepted,false); assert.equal(initial.items.length,2);
  assert.deepEqual(initial.quota,quota);
  assert.equal(initial.items[0].downloadCount,7); assert(!('content' in initial.items[0]));
  await assert.rejects(repo.marketAdd(version),/COMMUNITY_RULES_REQUIRED/);
  rules=true;
  await assert.rejects(repo.marketAdd({...version,id:denied.id}),/COMMUNITY_DOWNLOAD_PERMISSION_REQUIRED/);
  await assert.rejects(repo.marketAdd({...version,revision:2}),/COMMUNITY_REPOSITORY_CONFLICT/);
  assert.equal((await repo.marketAdd(version)).canceled,true);
  allowed=true;changeSession=true;
  await assert.rejects(repo.marketAdd(version),/COMMUNITY_ACCOUNT_CHANGED/);
  assert.equal(writes,0);
  changeSession=false;wrongContent=true;
  await assert.rejects(repo.marketAdd(version),/COMMUNITY_REPOSITORY_CONFLICT/);
  assert.deepEqual((await readReceiveLog(root)).items,[]);
  wrongContent=false;
  const nativeDir=join(root,'skills','original-local-skill'),nativeFile=join(nativeDir,'SKILL.md');
  await mkdir(nativeDir,{recursive:true});await writeFile(nativeFile,content);
  const beforeWrites=writes,beforeConfirmations=confirmations;
  assert.deepEqual(await repo.marketAdd(version),{saved:true,unchanged:true,downloadCount:7,localMatch:true});
  assert.equal(writes,beforeWrites,'do not create a cloud import for a verified local duplicate');
  assert.equal(confirmations,beforeConfirmations,'do not ask to save when the same content is already present');
  assert.deepEqual((await readReceiveLog(root)).items,[]);
  assert.equal(await readFile(nativeFile,'utf8'),content);
  // Same selected title, different local content: saving is still permitted.
  await writeFile(nativeFile,'# Market fixture\nDifferent instructions.');
  const saved=await repo.marketAdd(version);
  assert.deepEqual(saved,{saved:true,unchanged:false,downloadCount:8});
  assert.match(await readFile(nativeFile,'utf8'),/Different instructions/);
  await unlink(nativeFile);await rmdir(nativeDir);
  const receipt=(await readReceiveLog(root)).items[0];
  assert.match(await readFile(join(root,'skills',receipt.localId,'SKILL.md'),'utf8'),/Summarize the changes/);
  assert.equal((await repo.marketCatalog(owner)).items[0].added,true);
  assert.equal((await repo.marketAdd(version)).unchanged,true);
  includeOther=true;
  assert.equal((await repo.marketCatalog(owner)).items.find(item=>item.id===otherPublication.id).localMatch,true);
  assert.equal((await repo.marketAdd({...version,id:otherPublication.id})).localMatch,true);
  assert.equal(writes,2,'no POST on local replay');
  const own='skill:own-market-skill', ownDir=join(root,'skills','own-market-skill');
  await mkdir(ownDir);
  const skillPath=join(ownDir,'SKILL.md');
  await writeFile(skillPath,'# Own Skill\nSummarize a workspace.');
  rules=false;
  await assert.rejects(repo.marketUploadOptions(owner),/COMMUNITY_RULES_REQUIRED/);
  rules=true;
  const options=await repo.marketUploadOptions(owner);
  assert.deepEqual(options.items.map(item=>item.id),[own],'do not re-upload a received copy or built-in resource');
  assert.deepEqual(options.quota,quota);
  const preview=await repo.marketUploadPreview({accountId:owner,id:own});
  assert.match(preview.content,/Summarize a workspace/);
  const submission={accountId:owner,id:own,key:randomUUID(),fingerprint:preview.fingerprint,
    title:'Own Skill',summary:'Summarizes a workspace',downloadAllowed:false,consent:true};
  await assert.rejects(repo.marketSubmit({...submission,consent:false}),/COMMUNITY_INVALID_UPLOAD/);
  await assert.rejects(repo.marketSubmit({...submission,content:'Untrusted'}),/COMMUNITY_INVALID_UPLOAD/);
  await writeFile(skillPath,'# Own Skill\nChanged since review.');
  await assert.rejects(repo.marketSubmit(submission),/COMMUNITY_UPLOAD_SOURCE_CHANGED/);
  assert.equal(calls.filter(([action])=>action==='marketSubmit').length,0);
  await writeFile(skillPath,preview.content);
  const submitted=await repo.marketSubmit(submission);
  assert.equal(submitted.status,'pending');assert.equal(submitted.quota.remaining,1);
  const posted=calls.find(([action])=>action==='marketSubmit')[1];
  assert.deepEqual(posted,{key:submission.key,kind:'skill',fileName:'SKILL.md',content:preview.content,title:submission.title,
    summary:submission.summary,consent:true,rulesRevision:'2026-10-19.3',downloadAllowed:false});
  assert.equal(communityMarketRequest('marketSubmit',posted).path,'/community/submissions');
  const mineId=randomUUID(), mineHash=createHash('sha256').update(preview.content).digest('hex');
  mine=[{id:mineId,owner_id:owner,title:'Own Skill',summary:'Summarizes a workspace',kind:'skill',revision:2,
    sha256:mineHash,content:'Never include server resource text in the private listing',
    status:'approved',publication:{revision:1,visibility:'published'}}];
  assert.equal((await repo.marketUploadPreview({accountId:owner,id:own})).duplicate,true);
  await assert.rejects(repo.marketSubmit({...submission,title:'Renamed Skill',key:randomUUID()}),/COMMUNITY_DUPLICATE_SUBMISSION/);
  assert.equal(calls.filter(([action])=>action==='marketSubmit').length,1);
  assert.equal((await repo.marketSubmit(submission)).status,'pending','same payload and key may replay');
  const results=await repo.marketMine({accountId:owner,page:0});
  assert.equal(results.items[0].publication.revision,1);assert(!('content' in results.items[0]));
  const hide={accountId:owner,id:mineId,action:'unpublish',revision:2,publishedRevision:1};
  await assert.rejects(repo.marketManage({...hide,revision:1}),/COMMUNITY_REVISION_CONFLICT/);
  foreign=true;await assert.rejects(repo.marketManage(hide),/COMMUNITY_CATALOG_INVALID/);foreign=false;
  assert.equal((await repo.marketManage(hide)).canceled,true);
  manageAllowed=true;changeSession=true;
  await assert.rejects(repo.marketManage(hide),/COMMUNITY_ACCOUNT_CHANGED/);
  assert.equal(manages,0);
  changeSession=false;assert.equal((await repo.marketManage(hide)).changed,true);
  assert.equal(manages,1);
  assert.deepEqual(communityMarketRequest('marketManage',hide).options.body,{revision:2,publishedRevision:1});
  assert.equal(communityMarketRequest('marketCatalog',{kind:'skill',page:0,id:'../../anything'}),null);
  assert.deepEqual(communityMarketRequest('marketImport',version)?.options.body,{sha256,revision:1});
  console.log('PASS desktop marketplace: login/rules, download and scoped replay, local export, upload consent, reviewed snapshot binding, server quota projection.');
} finally { await rm(root,{recursive:true,force:true}); }

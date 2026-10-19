import { useEffect, useRef, useState } from 'react';
import { ACCOUNT_AGENT_AVATARS } from '../../shared/account-avatar.js';
export { ACCOUNT_AGENT_AVATARS } from '../../shared/account-avatar.js';
const STORAGE_KEY='aporiax.account-agent-avatars.v1';
function readChoices(){
  try{const value=JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter(([,template])=>ACCOUNT_AGENT_AVATARS.includes(template))):{};}catch{return {};}
}
// Server selection wins. Old device-only choices migrate with insert-only writes,
// so another device cannot overwrite a newer cloud choice during migration.
export function useAccountAvatar(owner,profile,api,onSnapshot){
  const [choices,setChoices]=useState(readChoices),[failure,setFailure]=useState(null),[saving,setSaving]=useState(false);
  const generation=useRef(0),working=useRef(false),migration=useRef(''),current=useRef(owner),snapshot=useRef(onSnapshot);
  current.current=owner;snapshot.current=onSnapshot;
  useEffect(()=>{generation.current++;working.current=false;setSaving(false);setFailure(null);migration.current='';},[owner]);
  useEffect(()=>{const reload=event=>{if(event.key===STORAGE_KEY||event.key===null)setChoices(readChoices());};window.addEventListener('storage',reload);return()=>window.removeEventListener('storage',reload);},[]);
  const persist=(id,template)=>{const updated={...readChoices(),[id]:template};try{localStorage.setItem(STORAGE_KEY,JSON.stringify(updated));}catch{/* Confirmed cloud selection is authoritative. */}setChoices(updated);};
  async function save(next,initializeOnly=false){
    if(!owner||working.current||!ACCOUNT_AGENT_AVATARS.includes(next))return false;
    const id=owner,version=generation.current;working.current=true;setSaving(true);setFailure(null);
    try{
      if(typeof api?.setAvatarTemplate!=='function')throw Error('ACCOUNT_AVATAR_SYNC_UNAVAILABLE');
      const result=await api.setAvatarTemplate({accountId:id,template:next,initializeOnly});
      if(current.current!==id||version!==generation.current)return false;
      if(result?.profile?.id!==id||!ACCOUNT_AGENT_AVATARS.includes(result.profile.avatarTemplate))throw Error('ACCOUNT_AVATAR_SAVE_FAILED');
      persist(id,result.profile.avatarTemplate);snapshot.current?.(result);return true;
    }catch{if(current.current===id&&version===generation.current)setFailure(id);return false;}
    finally{if(current.current===id&&version===generation.current){working.current=false;setSaving(false);}}
  }
  useEffect(()=>{
    if(!owner||profile?.avatarTemplateUpdatedAt||!Object.hasOwn(choices,owner)||migration.current===owner)return;
    migration.current=owner;void save(choices[owner],true);
  },[owner,profile?.avatarTemplateUpdatedAt,choices]);
  const template=profile?.avatarTemplateUpdatedAt&&ACCOUNT_AGENT_AVATARS.includes(profile.avatarTemplate)?profile.avatarTemplate:choices[owner]||'main';
  return {avatarTemplate:template,selectAvatar:save,avatarSaving:saving,avatarSaveError:Boolean(owner&&failure===owner)};
}

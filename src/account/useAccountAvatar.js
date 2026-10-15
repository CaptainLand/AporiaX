import { useEffect, useState } from 'react';

export const ACCOUNT_AGENT_AVATARS = ['main', 'explore', 'review', 'verify', 'builder', 'curator'];
const STORAGE_KEY = 'aporiax.account-agent-avatars.v1';
function readChoices() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([,template]) => ACCOUNT_AGENT_AVATARS.includes(template)));
  } catch { return {}; } // Invalid or unavailable local preferences use AporiaX.
}

// Device preference keyed by account ID, separate from the Cloud profile.
export function useAccountAvatar(owner) {
  const [choices, setChoices] = useState(readChoices);
  const [failure, setFailure] = useState(null);
  useEffect(() => {
    const reload = event => { if (event.key === STORAGE_KEY || event.key === null) setChoices(readChoices()); };
    window.addEventListener('storage', reload);
    return () => window.removeEventListener('storage', reload);
  }, []);
  const template = owner && Object.hasOwn(choices, owner) ? choices[owner] : 'main';
  function selectAvatar(next) {
    if (!owner || !ACCOUNT_AGENT_AVATARS.includes(next)) return false;
    const updated = { ...readChoices(), [owner]: next };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); }
    catch { setFailure(owner); return false; }
    setChoices(updated); setFailure(null); return true;
  }
  return { avatarTemplate: template, selectAvatar, avatarSaveError: Boolean(owner && failure === owner) };
}

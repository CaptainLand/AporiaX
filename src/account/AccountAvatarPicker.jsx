import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { AgentAvatar } from '../components/AgentAvatar.jsx';
import { agentName } from '../../shared/agent-identity.js';
import { useI18n } from '../i18n.jsx';
import { useAccount } from './AccountContext.jsx';
import { AccountAvatar } from './AccountAvatar.jsx';
import { ACCOUNT_AGENT_AVATARS } from './useAccountAvatar.js';
import './account-avatar-picker.css';

export function AccountAvatarPicker() {
  const { language, tr } = useI18n();
  const { avatarTemplate = 'main', selectAvatar, avatarSaveError } = useAccount();
  const [open, setOpen] = useState(false);
  const root = useRef(null), trigger = useRef(null), grid = useRef(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    grid.current?.querySelector('[aria-pressed="true"]')?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div className="account-avatar-picker" ref={root} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); }
  }} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button className="account-avatar-trigger" type="button" ref={trigger} aria-label={tr('更换账户头像', 'Change account avatar')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <AccountAvatar className="account-settings-avatar" /><i><Pencil size={10} /></i>
    </button>
    {open && <div className="account-avatar-choices" role="dialog" aria-label={tr('选择账户头像', 'Choose account avatar')}>
      <header><strong>{tr('选择头像', 'Choose an avatar')}</strong><button type="button" aria-label={tr('关闭头像选择', 'Close avatar picker')} onClick={close}><X size={15} /></button></header>
      <div className="account-avatar-grid" ref={grid} role="group" aria-label={tr('Agent 头像', 'Agent portraits')} onKeyDown={event => {
        const step = { ArrowRight:1, ArrowLeft:-1, ArrowDown:3, ArrowUp:-3 }[event.key];
        if (!step) return;
        const buttons=[...grid.current.querySelectorAll('button')], index=buttons.indexOf(document.activeElement);
        if (index >= 0) { event.preventDefault(); buttons[(index+step+buttons.length)%buttons.length].focus(); }
      }}>
        {ACCOUNT_AGENT_AVATARS.map(template => <button type="button" key={template} aria-pressed={avatarTemplate === template} onClick={() => { if (selectAvatar?.(template)) close(); }}>
          <AgentAvatar template={template} /><span>{agentName(template,language)}</span>{avatarTemplate === template && <Check size={12} />}
        </button>)}
      </div>
      {avatarSaveError && <p role="alert">{tr('头像未能保存，请重试。', 'Could not save the avatar. Please retry.')}</p>}
    </div>}
  </div>;
}

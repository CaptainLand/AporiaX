import { useEffect, useId, useRef, useState } from 'react';
import { Info, MoreHorizontal, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n';

export function SideChatMoreMenu({ canClear, onClear, onStatus }) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef(null), trigger = useRef(null), menu = useRef(null);
  const id = useId();
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = event => { if (!root.current?.contains(event.target)) close(); };
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); close(true);
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape, true); };
  }, [open]);
  const action = callback => { close(true); callback(); };
  return <div className="side-chat-more" ref={root} onBlur={event => {
    if (event.relatedTarget && !root.current?.contains(event.relatedTarget)) close();
  }}>
    <button type="button" ref={trigger} className="side-chat-icon" aria-label={tr('侧聊更多操作', 'More side chat actions')} title={tr('更多操作', 'More actions')} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)} onKeyDown={event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); }
    }}><MoreHorizontal size={17} /></button>
    {open && <div className="side-chat-more-menu" ref={menu} id={id} role="menu" aria-label={tr('侧聊更多操作', 'More side chat actions')} onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...menu.current.querySelectorAll('button:not(:disabled)')];
      if (!items.length) return;
      const current = items.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus({ preventScroll: true });
    }}>
      {onStatus && <button type="button" role="menuitem" onClick={() => action(onStatus)}><Info size={15} />{tr('查看任务状态', 'View task status')}</button>}
      <button type="button" role="menuitem" disabled={!canClear} onClick={() => action(onClear)}><Trash2 size={15} />{tr('清空侧聊历史', 'Clear side chat history')}</button>
    </div>}
  </div>;
}

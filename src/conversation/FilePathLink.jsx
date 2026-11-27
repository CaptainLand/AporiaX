import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText } from 'lucide-react';
import { useI18n } from '../i18n';
import './file-link.css';

export function FilePathLink({ href, path, note, onClick, onContextMenu, onKeyDown, children }) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  const anchor = useRef(null), tooltip = useRef(null), timer = useRef(null), keyboard = useRef(false);
  const clearTimer = useCallback(() => window.clearTimeout(timer.current), []);
  const dismiss = useCallback(() => { clearTimer(); setOpen(false); }, [clearTimer]);
  const schedule = (next, delay) => {
    clearTimer();
    timer.current = window.setTimeout(() => setOpen(next), delay);
  };
  const leave = () => { if (!keyboard.current) schedule(false, 140); };
  useEffect(() => clearTimer, [clearTimer]);

  useLayoutEffect(() => {
    if (!open) return;
    const popup = tooltip.current;
    const position = () => {
      const link = anchor.current.getBoundingClientRect();
      const { width, height } = popup.getBoundingClientRect();
      const { clientWidth, clientHeight } = document.documentElement;
      const inset = 10, gap = 6;
      const below = link.bottom + gap;
      const y = below + height <= clientHeight - inset ? below : link.top - gap - height;
      popup.style.left = `${Math.max(inset, Math.min(link.left, clientWidth - width - inset))}px`;
      popup.style.top = `${Math.max(inset, Math.min(y, clientHeight - height - inset))}px`;
      popup.style.visibility = 'visible';
    };
    const onScroll = event => { if (!(event.target instanceof Node) || !popup.contains(event.target)) dismiss(); };
    const onEscape = event => { if (event.key === 'Escape') dismiss(); };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onEscape);
    };
  }, [open, path, note, dismiss]);

  return <>
    <a ref={anchor} href={href} rel="noreferrer" aria-describedby={open ? id : undefined} aria-description={open ? undefined : path}
      onPointerEnter={event => { if (event.pointerType !== 'touch') schedule(true, 220); }} onPointerLeave={leave}
      onFocus={event => {
        keyboard.current = event.currentTarget.matches(':focus-visible');
        if (keyboard.current) { clearTimer(); setOpen(true); }
      }}
      onBlur={() => { keyboard.current = false; dismiss(); }}
      onClick={event => { dismiss(); onClick?.(event); }} onContextMenu={event => { dismiss(); onContextMenu?.(event); }}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) dismiss();
        onKeyDown?.(event);
      }}>
      <FileText className="conversation-file-link-icon" strokeWidth={1.75} aria-hidden="true" focusable="false" />{children}
    </a>
    {open && createPortal(<div ref={tooltip} id={id} role="tooltip" className="conversation-file-path-tooltip"
      onPointerEnter={clearTimer} onPointerLeave={leave}>
      <span className="conversation-file-path-heading">{tr('文件路径', 'File path')}</span>
      <code dir="auto">{path}</code>
      {note && note !== path && <span className="conversation-file-path-note">{note}</span>}
    </div>, document.body)}
  </>;
}

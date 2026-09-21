import { useId, useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import { useI18n } from "../i18n";

// The native top layer keeps details out of the conversation layout and supplies
// a focus trap without mounting another window or touching the main Agent run.
export function SideChatDialog({ title, subtitle, label, onClose, children, footer, className = "" }) {
  const { tr } = useI18n();
  const dialogRef = useRef(null), closeRef = useRef(null), backdropPress = useRef(false);
  const titleId = useId(), subtitleId = useId();
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    if (!dialogRef.current.contains(document.activeElement)) closeRef.current?.focus({ preventScroll: true });
  }, [title]);
  const outside = (event) => {
    if (event.target !== dialogRef.current) return false;
    const rect = dialogRef.current.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  return <dialog ref={dialogRef} className={`side-chat-dialog ${className}`.trim()} aria-label={label} aria-labelledby={label ? undefined : titleId} aria-describedby={subtitle ? subtitleId : undefined}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
    onPointerDown={(event) => { backdropPress.current = outside(event); }}
    onPointerUp={(event) => { if (backdropPress.current && outside(event)) onClose(); backdropPress.current = false; }}>
    <header className="side-chat-dialog-heading">
      <div><h2 id={titleId}>{title}</h2>{subtitle && <p id={subtitleId}>{subtitle}</p>}</div>
      <button ref={closeRef} autoFocus type="button" className="side-chat-icon" aria-label={tr("关闭弹窗", "Close dialog")} title={tr("关闭（Esc）", "Close (Esc)")} onClick={onClose}><X size={17} /></button>
    </header>
    <div className="side-chat-dialog-body">{children}</div>
    {footer && <footer className="side-chat-dialog-footer">{footer}</footer>}
  </dialog>;
}

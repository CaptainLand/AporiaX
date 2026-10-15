import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, MessageSquareQuote } from "lucide-react";
import { useI18n } from "../i18n";
import "./conversation-selection.css";

// Scope selection to this conversation. Editors and unselected links retain
// their native context menus; nothing is sent until the user presses Send.
export function ConversationSelectionMenu({ children, onQuote, onNotice, onOpenChange }) {
  const { tr } = useI18n();
  const root = useRef(null), menuRef = useRef(null), returnFocus = useRef(null);
  const [menu, setMenu] = useState(null), [error, setError] = useState("");
  useEffect(() => { onOpenChange?.(Boolean(menu)); return () => onOpenChange?.(false); }, [Boolean(menu), onOpenChange]);
  useEffect(() => {
    if (!menu) return;
    const outside = event => { if (!menuRef.current?.contains(event.target)) setMenu(null); };
    const dismiss = () => setMenu(null);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [menu]);
  useLayoutEffect(() => {
    if (!menu) return;
    const element = menuRef.current, bounds = element.getBoundingClientRect();
    element.style.left = Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8)) + "px";
    element.style.top = Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8)) + "px";
    element.querySelector("button")?.focus({ preventScroll: true });
  }, [menu, error]);
  const open = event => {
    if (event.target.closest("input,textarea,[contenteditable=true]")) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !selection.toString().trim()) return;
    if (!root.current.contains(selection.anchorNode) || !root.current.contains(selection.focusNode)) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = selection.getRangeAt(0).getBoundingClientRect();
    returnFocus.current = document.activeElement;
    setError("");
    setMenu({ text: selection.toString(), x: event.clientX || bounds.left, y: event.clientY || bounds.bottom });
  };
  const quote = () => { const text = menu.text; setMenu(null); onQuote(text); };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(menu.text);
      setMenu(null);
      returnFocus.current?.focus?.({ preventScroll: true });
      onNotice?.(tr("已复制选中文字", "Selected text copied"));
    } catch {
      setError(tr("复制失败，请使用 Ctrl+C 复制选中文字。", "Copy failed. Use Ctrl+C to copy the selected text."));
    }
  };
  return <div className="conversation-selection-scope" ref={root} onContextMenuCapture={open}>
    {children}
    {menu && createPortal(<div ref={menuRef} className="conversation-selection-menu" role="menu" aria-label={tr("选中文字操作", "Selected text actions")} style={{ left: menu.x, top: menu.y }} onKeyDown={event => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault(); setMenu(null); returnFocus.current?.focus?.({ preventScroll: true });
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = [...menuRef.current.querySelectorAll("button")], index = buttons.indexOf(document.activeElement);
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    }}>
      <button type="button" role="menuitem" onClick={quote}><MessageSquareQuote size={15} />{tr("添加到对话", "Add to conversation")}</button>
      <button type="button" role="menuitem" onClick={() => void copy()}><Copy size={15} />{tr("复制选中文字", "Copy selected text")}</button>
      <small>{tr("添加到输入框，不会自动发送", "Adds to the composer without sending")}</small>
      {error && <p role="alert">{error}</p>}
    </div>, document.body)}
  </div>;
}

export function appendConversationQuote(draft, text) {
  const quoted = text.trim().split(/\r?\n/).map(line => `> ${line}`).join("\n");
  return `${draft}${draft && !draft.endsWith("\n\n") ? draft.endsWith("\n") ? "\n" : "\n\n" : ""}${quoted}\n\n`;
}

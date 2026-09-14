import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Ellipsis, Search, Square, X } from "lucide-react";
import { useI18n } from "../i18n";
import { SideChatDialog } from "./SideChatDialog.jsx";
import { sameScope } from "./state.js";
import { acquireTerminalSession, consumeTerminalFocus, terminalPreferences, saveTerminalPreferences } from "./terminal-session.js";
import "./side-chat.css";
import "./terminal.css";

export function TerminalPane({ tab, resource, workbench }) {
  const { tr } = useI18n();
  const host = useRef(null), root = useRef(null), controller = useRef(null), menuRef = useRef(null), searchRef = useRef(null);
  const [session, setSession] = useState({ status: resource?.status, atBottom: true });
  const [preferences, setPreferences] = useState(terminalPreferences);
  const [appTheme, setAppTheme] = useState(() => document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const [searchOpen, setSearchOpen] = useState(false), [query, setQuery] = useState(""), [found, setFound] = useState(null);
  const [menu, setMenu] = useState(null), [paste, setPaste] = useState(null), [rename, setRename] = useState(null);
  const [focused, setFocused] = useState(false), [uiError, setUiError] = useState("");
  const theme = preferences.theme === "auto" ? appTheme : preferences.theme;
  const exited = session.status === "exited";
  useEffect(() => {
    const observer = new MutationObserver(() => setAppTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!resource || !host.current || !sameScope(resource, workbench.task)) return;
    const value = acquireTerminalSession({ scope: workbench.key, id: tab.id, resource, request: workbench.request, openHref: workbench.openHref, tr });
    controller.current = value;
    const off = value.subscribe(setSession);
    const detach = value.attach(host.current, { search: () => setSearchOpen(true), paste: setPaste, autofocus: consumeTerminalFocus(workbench.key, tab.id) });
    value.style(preferences, appTheme);
    return () => { off(); detach(); controller.current = null; };
  }, [tab.id, resource?.id, workbench.key]);
  useEffect(() => controller.current?.style(preferences, appTheme), [preferences, appTheme]);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  useEffect(() => {
    if (!menu) return;
    const close = (event) => { if (!menuRef.current?.contains(event.target)) setMenu(null); };
    const key = (event) => { if (event.key === "Escape") { event.preventDefault(); setMenu(null); controller.current?.term.focus(); } };
    window.addEventListener("pointerdown", close); window.addEventListener("keydown", key);
    menuRef.current?.querySelector("button")?.focus();
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", key); };
  }, [menu]);
  const changePreferences = (patch) => {
    const value = { ...preferences, ...patch }; setPreferences(value);
    try { saveTerminalPreferences(value); } catch { setUiError(tr("终端偏好未能保存。", "Terminal preferences could not be saved.")); }
  };
  const closeSearch = () => { setSearchOpen(false); setFound(null); controller.current?.search.clearDecorations(); controller.current?.term.focus(); };
  const find = (previous = false, value = query, incremental = false) => {
    const addon = controller.current?.search;
    if (!value) { addon?.clearDecorations(); setFound(null); return; }
    const result = previous ? addon?.findPrevious(value) : addon?.findNext(value, { incremental });
    setFound(Boolean(result));
  };
  const action = (fn) => { setMenu(null); void fn(); };
  const stateText = exited ? tr("已退出", "Exited") + (session.exitCode != null ? ` · ${session.exitCode}` : "")
    : focused ? tr("可输入", "Input focused") : tr("Shell 已连接", "Shell connected");
  return <section ref={root} className="terminal-pane" data-terminal-theme={theme} aria-label={tr("交互终端", "Interactive terminal")}
    onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && !event.target.closest("dialog")) { event.preventDefault(); event.stopPropagation(); setMenu(null); setSearchOpen(true); } }}
    onContextMenu={(event) => {
      if (event.target.closest("input,textarea,dialog")) return;
      event.preventDefault(); const rect = root.current.getBoundingClientRect();
      setMenu({ left: Math.max(8, Math.min(event.clientX - rect.left, rect.width - 242)), top: Math.max(40, Math.min(event.clientY - rect.top, rect.height - 350)) });
    }}>
    <div className="terminal-toolbar">
      <span className="terminal-location" title={tr("初始目录：", "Initial directory: ") + (resource?.cwd || "")}>{resource?.cwd || "PowerShell"}</span>
      <span className="terminal-connection" data-exited={exited} title={stateText + " · " + tr("关闭标签会结束会话", "Closing the tab ends the session")} aria-label={stateText} />
      <button aria-label={tr("搜索终端", "Search terminal")} title="Ctrl+F" onClick={() => { if (searchOpen) closeSearch(); else setSearchOpen(true); }}><Search size={15} /></button>
      <button aria-label={tr("中断", "Interrupt")} title={tr("Ctrl+C · 中断当前命令，保留 Shell", "Ctrl+C · Interrupt command, keep shell")} disabled={exited || !resource} onClick={async () => { await controller.current?.command({ action: "interrupt" }); controller.current?.term.focus(); }}><Square size={12} /></button>
      <button aria-label={tr("终端菜单", "Terminal menu")} aria-expanded={Boolean(menu)} onClick={() => setMenu(menu ? null : { right: 8, top: 38 })}><Ellipsis size={17} /></button>
    </div>
    {searchOpen && <div className="terminal-search" role="search" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSearch(); } }}>
      <Search size={14} /><input ref={searchRef} aria-label={tr("搜索终端输出", "Search terminal output")} value={query} placeholder={tr("搜索输出", "Find in output")}
        onChange={(event) => { setQuery(event.target.value); find(false, event.target.value, true); }}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); find(event.shiftKey); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSearch(); } }} />
      <span role="status">{found === false ? tr("未找到", "No match") : ""}</span>
      <button aria-label={tr("上一个匹配", "Previous match")} onClick={() => find(true)}><ArrowUp size={14} /></button>
      <button aria-label={tr("下一个匹配", "Next match")} onClick={() => find()}><ArrowDown size={14} /></button>
      <button aria-label={tr("关闭搜索", "Close search")} onClick={closeSearch}><X size={14} /></button>
    </div>}
    {(uiError || session.failure || session.readFailure) && <div className="terminal-error" role="alert">{uiError || session.failure || session.readFailure}<button onClick={() => { setUiError(""); controller.current?.retry(); }}>{tr("重试", "Retry")}</button></div>}
    {session.truncated && <div className="terminal-notice">{tr("较早输出已超出保留范围，当前画面可能不完整。", "Earlier output exceeded retention; this screen may be incomplete.")}</div>}
    <div className="terminal-screen-wrap">
      <div className="workbench-xterm" ref={host} onFocusCapture={() => setFocused(true)} onBlurCapture={() => setFocused(false)}
        onMouseDown={(event) => { if (event.button === 0) controller.current?.term.focus(); }} />
      {!session.atBottom && <button className="terminal-bottom" aria-label={tr("回到底部", "Scroll to bottom")} onClick={() => { controller.current?.term.scrollToBottom(); controller.current?.term.focus(); }}><ArrowDown size={16} />{tr("最新输出", "Latest output")}</button>}
    </div>
    {exited && <div className="terminal-exit" role="status"><span>{session.drained ? stateText : tr("正在读取最后的输出…", "Draining final output…")}</span><button onClick={() => workbench.create("terminal")}>{tr("新建终端", "New terminal")}</button></div>}
    {menu && <div className="terminal-menu" ref={menuRef} style={menu} role="menu" aria-label={tr("终端操作", "Terminal actions")}>
      <button role="menuitem" disabled={!session.selected} onClick={() => action(() => controller.current?.copy())}><Copy size={14} />{tr("复制", "Copy")}<kbd>Ctrl+C</kbd></button>
      <button role="menuitem" disabled={exited} onClick={() => action(() => controller.current?.pasteClipboard())}>{tr("粘贴", "Paste")}<kbd>Ctrl+V</kbd></button>
      <button role="menuitem" onClick={() => action(() => controller.current?.term.selectAll())}>{tr("全选", "Select all")}</button>
      <button role="menuitem" onClick={() => action(() => controller.current?.clear())}>{tr("清屏", "Clear")}</button>
      <button role="menuitem" onClick={() => action(() => setRename(resource?.title || tab.title))}>{tr("重命名", "Rename")}</button>
      <div className="terminal-menu-settings"><span>{tr("主题", "Theme")}</span><div>{[["auto", "跟随", "Auto"], ["light", "浅色", "Light"], ["dark", "深色", "Dark"]].map(([value, zh, en]) => <button key={value} aria-pressed={preferences.theme === value} onClick={() => changePreferences({ theme: value })}>{tr(zh, en)}</button>)}</div></div>
      <div className="terminal-menu-settings"><span>{tr("字号", "Font size")}</span><div><button aria-label={tr("缩小终端字号", "Decrease terminal font")} disabled={preferences.fontSize <= 10} onClick={() => changePreferences({ fontSize: preferences.fontSize - 1 })}>−</button><span>{preferences.fontSize}</span><button aria-label={tr("放大终端字号", "Increase terminal font")} disabled={preferences.fontSize >= 22} onClick={() => changePreferences({ fontSize: preferences.fontSize + 1 })}>+</button></div></div>
      <button role="menuitem" className="terminal-menu-danger" onClick={() => action(() => workbench.close(tab.id))}>{tr("结束并关闭终端", "End and close terminal")}</button>
    </div>}
    {paste !== null && <SideChatDialog title={tr("确认粘贴到终端", "Confirm terminal paste")} subtitle={tr("内容包含换行或控制字符，可能执行多条命令。", "Contains newlines or control characters and may execute commands.")} onClose={() => setPaste(null)}
      footer={<><button onClick={() => setPaste(null)}>{tr("取消", "Cancel")}</button><button className="primary" disabled={exited} onClick={() => { controller.current?.paste(paste); setPaste(null); }}>{tr("确认粘贴", "Paste")}</button></>}>
      <pre className="terminal-paste-preview">{paste.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`)}</pre>
    </SideChatDialog>}
    {rename !== null && <SideChatDialog title={tr("重命名终端", "Rename terminal")} onClose={() => setRename(null)}>
      {session.failure && <p className="terminal-error" role="alert">{session.failure}</p>}
      <form className="terminal-rename" onSubmit={async (event) => { event.preventDefault(); const result = await controller.current?.command({ action: "terminal-rename", text: rename }); if (result) setRename(null); }}>
        <input aria-label={tr("终端名称", "Terminal name")} value={rename} maxLength={80} required onChange={(event) => setRename(event.target.value)} />
        <button>{tr("保存名称", "Save name")}</button>
      </form>
    </SideChatDialog>}
  </section>;
}

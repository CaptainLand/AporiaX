import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

export const TERMINAL_THEMES = {
  light: { background: "#ffffff", foreground: "#302a37", cursor: "#302a37", cursorAccent: "#ffffff", selectionBackground: "#d6e7ef", selectionForeground: "#302a37",
    black: "#302a37", red: "#b43d45", green: "#28704f", yellow: "#98660c", blue: "#3269a1", magenta: "#845492", cyan: "#147b8a", white: "#74707b",
    brightBlack: "#80798a", brightRed: "#b82a34", brightGreen: "#217147", brightYellow: "#966008", brightBlue: "#2866a5", brightMagenta: "#87549a", brightCyan: "#147281", brightWhite: "#302a37" },
  dark: { background: "#17141d", foreground: "#e0dce8", cursor: "#e0dce8", cursorAccent: "#17141d", selectionBackground: "#384856", selectionForeground: "#ffffff",
    black: "#5a5460", red: "#ff8b92", green: "#9ece6a", yellow: "#e0af68", blue: "#8bb4ff", magenta: "#d0b4ff", cyan: "#7dcfff", white: "#e0dce8",
    brightBlack: "#aaa3b7", brightRed: "#ffb0b5", brightGreen: "#c6f08a", brightYellow: "#f4d08a", brightBlue: "#adc8ff", brightMagenta: "#e2ccff", brightCyan: "#b4f0ff", brightWhite: "#ffffff" },
};
const sessions = new Map();
const focusRequests = new Set();
const cacheKey = (scope, id) => JSON.stringify([scope, id]);
export const peekTerminalSession = (scope, id) => sessions.get(cacheKey(scope, id));
export const requestTerminalFocus = (scope, id) => focusRequests.add(cacheKey(scope, id));
export const consumeTerminalFocus = (scope, id) => focusRequests.delete(cacheKey(scope, id));
const preferenceKey = "aporiax.terminal.preferences.v2";
export function terminalPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) || "{}");
    return { theme: ["auto", "light", "dark"].includes(value.theme) ? value.theme : "auto", fontSize: Math.max(10, Math.min(22, Number(value.fontSize) || 14)) };
  } catch { return { theme: "auto", fontSize: 14 }; }
}
export function saveTerminalPreferences(value) { localStorage.setItem(preferenceKey, JSON.stringify(value)); }
export const needsPasteConfirmation = (text) => /[\u0000-\u001f\u007f]/.test(text);

export function disposeTerminalSession(scope, id) {
  const key = cacheKey(scope, id), session = sessions.get(key);
  session?.dispose(); sessions.delete(key); focusRequests.delete(key);
}
export function reconcileTerminalSessions(scope, ids) {
  for (const session of sessions.values()) if (session.scope === scope && !ids.has(session.id)) disposeTerminalSession(scope, session.id);
}
export function acquireTerminalSession({ scope, id, resource, request, openHref, tr }) {
  const key = cacheKey(scope, id);
  if (!sessions.has(key)) sessions.set(key, createSession({ scope, id, resource, request, openHref, tr }));
  const session = sessions.get(key);
  session.request = request; session.openHref = openHref; session.tr = tr;
  return session;
}

function createSession({ scope, id, resource, request, openHref, tr }) {
  const box = document.createElement("div"); box.className = "terminal-session-screen";
  const term = new Terminal({ cursorBlink: false, cursorStyle: "block", cursorInactiveStyle: "outline",
    fontFamily: '"Cascadia Mono", Consolas, "Microsoft YaHei", monospace', fontSize: 14, lineHeight: 1.3,
    theme: TERMINAL_THEMES.light, minimumContrastRatio: 4.5, scrollback: 5000, scrollOnUserInput: true });
  const fit = new FitAddon(), search = new SearchAddon({ highlightLimit: 500 });
  term.loadAddon(fit); term.loadAddon(search);
  let cursor = 0, disposed = false, attached = false, reading = false, timer, observer, frame, handlers = {}, inputQueue = Promise.resolve();
  let lastSize = "", retryDelay = 750;
  let inputUntil = 0, wakeRequested = false;
  const listeners = new Set(), pendingWrites = new Set();
  let snapshot = { status: resource.status, exitCode: resource.exitCode, drained: false, failure: "", readFailure: "", truncated: false, atBottom: true, selected: false };
  const update = (patch) => {
    if (disposed || Object.entries(patch).every(([name, value]) => snapshot[name] === value)) return;
    snapshot = { ...snapshot, ...patch }; listeners.forEach((fn) => fn(snapshot));
  };
  const session = {
    scope, id, term, search, request, openHref, tr,
    get snapshot() { return snapshot; },
    subscribe(fn) { listeners.add(fn); fn(snapshot); return () => listeners.delete(fn); },
    report(error) { update({ failure: error?.message || String(error) }); },
    async command(data) {
      try {
        const result = await session.request({ id, ...data });
        if (result?.missing) throw new Error(session.tr("终端会话已失效。", "Terminal session expired."));
        if (data.action === "write" || data.action === "interrupt") wakeInput();
        return result;
      }
      catch (error) { session.report(error); return null; }
    },
    retry() { update({ failure: "", readFailure: "" }); retryDelay = 750; schedule(0); },
    clear() { term.clear(); term.focus(); },
    async copy() { const text = term.getSelection(); if (text) await session.command({ action: "terminal-copy", text }); },
    async pasteClipboard() { const result = await session.command({ action: "terminal-paste" }); if (result) session.preparePaste(result.text); },
    preparePaste(text) {
      if (snapshot.status !== "running" || typeof text !== "string" || !text) return;
      if (text.length > 60000) { session.report(new Error(session.tr("粘贴不能超过 60,000 字符。", "Paste is limited to 60,000 characters."))); return; }
      if (needsPasteConfirmation(text)) handlers.paste?.(text); else session.paste(text);
    },
    paste(text) { if (snapshot.status === "running") { term.focus(); term.paste(text); } },
    style(preferences, appTheme) {
      const theme = preferences.theme === "auto" ? appTheme : preferences.theme;
      term.options.theme = TERMINAL_THEMES[theme] || TERMINAL_THEMES.light;
      if (term.options.fontSize !== preferences.fontSize) { term.options.fontSize = preferences.fontSize; resize(); }
    },
    attach(host, callbacks) {
      attached = true; handlers = callbacks; host.appendChild(box);
      observer = new ResizeObserver(resize); observer.observe(host);
      frame = requestAnimationFrame(() => { resize(); if (callbacks.autofocus) term.focus(); });
      document.fonts?.ready.then(() => { if (!disposed && attached) resize(); });
      schedule(0);
      return () => {
        attached = false; handlers = {}; term.blur(); observer?.disconnect(); cancelAnimationFrame(frame); box.remove();
      };
    },
    dispose() {
      disposed = true; clearTimeout(timer); cancelAnimationFrame(frame); observer?.disconnect(); listeners.clear();
      pendingWrites.forEach((done) => done()); pendingWrites.clear(); term.dispose(); box.remove();
    },
  };
  term.loadAddon(new WebLinksAddon((event, uri) => {
    event?.preventDefault(); void session.openHref(uri).catch(session.report);
  }));
  term.open(box);
  term.onData((data) => {
    if (disposed || snapshot.status !== "running" || resource.owner !== "user") return;
    wakeInput();
    // Preserve input packet ordering, including terminal protocol replies.
    inputQueue = inputQueue.then(() => disposed ? null : session.command({ action: "write", data }));
  });
  term.onSelectionChange(() => update({ selected: term.hasSelection() }));
  term.onScroll(() => update({ atBottom: term.buffer.active.viewportY >= term.buffer.active.baseY }));
  term.attachCustomKeyEventHandler((event) => {
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (!modifier) return true;
    const action = key === "f" ? () => handlers.search?.() : key === "c" && (term.hasSelection() || event.shiftKey) ? () => void session.copy()
      : key === "v" ? () => void session.pasteClipboard() : null;
    if (action) { event.preventDefault(); event.stopPropagation(); if (event.type === "keydown") action(); return false; }
    return true;
  });
  // Capture the DOM paste before xterm's handler, including native context paste.
  box.addEventListener("paste", (event) => { event.preventDefault(); event.stopImmediatePropagation(); session.preparePaste(event.clipboardData?.getData("text/plain") || ""); }, true);
  function resize() {
    if (!attached || disposed || box.clientWidth < 8 || box.clientHeight < 8) return;
    const previous = term.buffer.active.viewportY, bottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
    fit.fit(); if (!bottom) term.scrollToLine(previous);
    const size = `${term.cols}:${term.rows}`;
    if (snapshot.status === "running" && size !== lastSize) {
      lastSize = size; void session.command({ action: "resize-terminal", cols: term.cols, rows: term.rows }).then((value) => { if (value === null) lastSize = ""; });
    }
  }
  function schedule(delay) { clearTimeout(timer); if (!disposed && !snapshot.drained) timer = setTimeout(pull, delay); }
  function wakeInput() {
    inputUntil = performance.now() + 1000;
    wakeRequested = true;
    if (!reading) schedule(0);
  }
  function write(data) {
    return new Promise((done) => { pendingWrites.add(done); term.write(data, () => { pendingWrites.delete(done); done(); }); });
  }
  async function pull() {
    if (disposed || reading || snapshot.drained) return;
    reading = true; wakeRequested = false;
    let nextDelay = attached ? 750 : 1500;
    try {
      const chunk = await session.request({ action: "read", id, cursor, waitMs: attached ? 750 : 1500 });
      if (disposed) return;
      if (chunk?.missing) { update({ status: "exited", drained: true, failure: session.tr("终端会话已失效，请新建终端。", "Session expired. Open a new terminal.") }); return; }
      if (chunk.cursorExpired) {
        term.reset(); update({ truncated: true });
      }
      if (chunk.output) await write(chunk.output);
      if (disposed) return;
      cursor = chunk.cursor ?? cursor;
      const hasMore = chunk.hasMore === true || (Number.isFinite(chunk.endCursor) && cursor < chunk.endCursor);
      const drained = chunk.status === "exited" && !hasMore;
      term.options.disableStdin = chunk.status === "exited";
      update({ status: chunk.status, exitCode: chunk.exitCode, drained, readFailure: "", atBottom: term.buffer.active.viewportY >= term.buffer.active.baseY });
      retryDelay = 750;
      // New backends wait for output inside the bounded read. Old backends keep
      // adaptive idle polling but temporarily poll fast during keyboard input.
      nextDelay = hasMore || chunk.waitSupported ? 0 : performance.now() < inputUntil ? 16 : chunk.output ? (attached ? 50 : 300) : nextDelay;
    } catch (error) { update({ readFailure: error.message }); nextDelay = retryDelay; retryDelay = Math.min(10000, retryDelay * 2); }
    finally { reading = false; schedule(wakeRequested ? 0 : nextDelay); }
  }
  schedule(0);
  return session;
}

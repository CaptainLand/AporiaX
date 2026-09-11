import { useEffect, useMemo, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import hljs from "highlight.js/lib/common";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { FileText, GitCompare, Globe, TerminalSquare } from "lucide-react";
import { FileExplorerPanel } from "../agent-components.jsx";
import { useI18n } from "../i18n";
import { normalizeBrowserUrl } from "../../electron/browser-url.js";
import "@xterm/xterm/css/xterm.css";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const LANG = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  json: "json",
  css: "css",
  scss: "scss",
  md: "markdown",
  html: "xml",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  bash: "bash",
  sql: "sql",
  c: "c",
  cpp: "cpp",
  h: "c",
  cs: "csharp",
};

function extensionOf(path) {
  return String(path || "").split(".").at(-1)?.toLowerCase() || "";
}

export function WorkbenchContent({
  tab,
  task,
  resource,
  workbench,
  builtins,
  onNotice,
  onNeedWorkspace,
  covered,
}) {
  const { tr } = useI18n();
  if (!tab) {
    const openFile = () => {
      if (!workbench.task.workspacePath) onNeedWorkspace?.();
      else workbench.open("workspace");
    };
    return (
      <div className="workbench-empty">
        <div className="workbench-empty-grid">
          <button type="button" className="workbench-empty-card" onClick={() => workbench.open("route")}>
            <GitCompare size={22} strokeWidth={1.6} />
            {tr("变更", "Changes")}
          </button>
          <button type="button" className="workbench-empty-card" onClick={() => workbench.create("browser")}>
            <Globe size={22} strokeWidth={1.6} />
            Browser
          </button>
          <button type="button" className="workbench-empty-card" onClick={() => workbench.create("terminal")}>
            <TerminalSquare size={22} strokeWidth={1.6} />
            {tr("终端", "Terminal")}
          </button>
          <button type="button" className="workbench-empty-card" onClick={openFile}>
            <FileText size={22} strokeWidth={1.6} />
            {tr("文件", "File")}
          </button>
        </div>
      </div>
    );
  }
  if (tab.kind === "route") return builtins.route;
  if (tab.kind === "understanding") return builtins.understanding;
  if (tab.kind === "workspace") {
    return (
      <WorkspacePane task={task} workbench={workbench} onNotice={onNotice}>
        {builtins.workspace}
      </WorkspacePane>
    );
  }
  if (tab.kind === "file") {
    return <FilePane tab={tab} task={task} workbench={workbench} onNotice={onNotice} />;
  }
  if (tab.kind === "browser") {
    return <BrowserPane tab={tab} resource={resource} workbench={workbench} covered={covered} />;
  }
  if (tab.kind === "terminal") {
    return <TerminalPane tab={tab} resource={resource} workbench={workbench} />;
  }
  if (tab.kind === "process") {
    return <ProcessPane tab={tab} resource={resource} workbench={workbench} />;
  }
  return <div className="workbench-notice">{tr("未知内容类型。", "Unknown content type.")}</div>;
}

export function WorkspaceFiles({ task, workbench, onNotice }) {
  return (
    <FileExplorerPanel
      workspacePath={task.workspacePath}
      embedded
      onNotice={onNotice}
      onOpenFile={(path) => workbench.openFile(path)}
    />
  );
}

function WorkspacePane({ task, workbench, onNotice, children }) {
  const { tr } = useI18n();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState(null);
  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      workbench
        .request({ action: "search", query })
        .then(setHits)
        .catch((error) => onNotice(error.message));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query, workbench.key, task.id]);
  return (
    <div className="workbench-file">
      <div className="workbench-toolbar">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tr("搜索工作区文件名（最多 200 条）", "Search workspace file names (max 200)")}
          aria-label={tr("工作区文件搜索", "Workspace file search")}
        />
      </div>
      {hits ? (
        <>
          <div className="workbench-search-hint">
            {tr(
              "已遍历到限额前的文件名结果，已排除 node_modules/.git 等目录。",
              "Filename results up to the walk limit, excluding node_modules/.git and similar directories.",
            )}
            {hits.truncated ? tr(" 结果已截断。", " Results truncated.") : ""}
          </div>
          <div className="workspace-tree">
            {hits.entries.map((entry) => (
              <button
                type="button"
                key={entry.path}
                title={tr("双击打开文件", "Double-click to open")}
                onDoubleClick={() => workbench.openFile(entry.path)}
              >
                {entry.path}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="workspace-view-stack workspace-tree-only">{children}</div>
      )}
    </div>
  );
}

function FilePane({ tab, task, workbench, onNotice }) {
  const { tr, language } = useI18n();
  const ext = extensionOf(tab.path);
  const [payload, setPayload] = useState(null);
  const [mode, setMode] = useState("read");
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [query, setQuery] = useState("");
  const [fit, setFit] = useState("contain");
  const [zoom, setZoom] = useState(1);
  const dirty = mode === "edit" && content !== saved;
  const languageName =
    (LANG[ext] && hljs.getLanguage(LANG[ext]) && LANG[ext]) || "plaintext";
  const html = useMemo(() => {
    const highlighted = hljs.highlight(content || " ", {
      language: languageName,
      ignoreIllegals: true,
    }).value;
    const lines = (content || "").split("\n");
    const needle = query.trim().toLowerCase();
    return highlighted.split("\n").map((line, index) => {
      const plain = lines[index] || "";
      const mark =
        (needle && plain.toLowerCase().includes(needle)) || tab.line === index + 1
          ? " mark"
          : "";
      return `<div class="workbench-code-line${mark}"><span class="wb-gutter">${index + 1}</span><span class="wb-code-src">${line || " "}</span></div>`;
    }).join("");
  }, [content, languageName, query, tab.line]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        if (IMAGE_EXT.has(ext) || ext === "docx") {
          const file = await workbench.request({ action: "file", path: tab.path });
          if (!cancelled) setPayload(file);
          return;
        }
        const preview = await window.desktop.workspace.readPreview(
          task.workspacePath,
          tab.path,
        );
        if (cancelled) return;
        setPayload({ kind: preview.binary ? "binary" : "text", ...preview });
        const next = preview.binary ? "" : preview.content || "";
        const draft = workbench.draft(tab.id);
        setSaved(next);
        setContent(typeof draft === "string" ? draft : next);
        if (typeof draft === "string" && draft !== next) {
          workbench.dirty.current.add(tab.id);
          setMode("edit");
        }
      } catch (error) {
        if (!cancelled) onNotice(error.message);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [tab.id, tab.path, tab.revision, task.workspacePath]);

  useEffect(() => {
    if (dirty) workbench.dirty.current.add(tab.id);
    else workbench.dirty.current.delete(tab.id);
    if (mode === "edit") workbench.saveDraft(tab.id, content);
  }, [content, dirty, mode, tab.id]);

  const save = async () => {
    const result = await window.desktop.workspace.saveText({
      workspacePath: task.workspacePath,
      requestedPath: tab.path,
      content,
      expectedContent: saved,
    });
    setSaved(result.content);
    setContent(result.content);
    workbench.saveDraft(tab.id, null);
    workbench.dirty.current.delete(tab.id);
    onNotice(tr("已保存 {path}", "Saved {path}", { path: result.path }));
  };

  const openNative = () => {
    void window.desktop?.links?.activate({
      href: tab.path,
      action: "open",
      workspacePath: task.workspacePath,
      language,
    });
  };

  if (!payload) {
    return <div className="workbench-notice">{tr("正在打开文件", "Opening file")}</div>;
  }
  if (payload.kind === "image") {
    return (
      <div className="workbench-file">
        <div className="workbench-toolbar">
          <button type="button" className="workbench-icon" onClick={() => setFit("contain")}>
            {tr("适应", "Fit")}
          </button>
          <button type="button" className="workbench-icon" onClick={() => setFit("original")}>
            {tr("原始", "Original")}
          </button>
          <button type="button" className="workbench-icon" onClick={() => setZoom((value) => Math.min(4, value + 0.25))}>
            +
          </button>
          <button type="button" className="workbench-icon" onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}>
            −
          </button>
          <span className="workbench-status">{Math.round((payload.size || 0) / 1024)} KB</span>
        </div>
        <div className="workbench-image" data-fit={fit}>
          <img
            alt={tab.title}
            src={`data:${payload.mime};base64,${payload.data}`}
            style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}
          />
        </div>
      </div>
    );
  }
  if (payload.kind === "docx") {
    return <DocxPane data={payload.data} onOpenNative={openNative} />;
  }
  if (payload.binary) {
    return (
      <div className="workbench-notice">
        {tr("此文件不能作为文本预览。", "This file cannot be previewed as text.")}
      </div>
    );
  }

  return (
    <div className="workbench-file">
      <div className="workbench-toolbar">
        <span className="workbench-status">{tab.path}</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tr("搜索", "Search")}
        />
        {mode === "read" ? (
          <button type="button" className="workbench-icon" onClick={() => setMode("edit")}>
            {tr("编辑", "Edit")}
          </button>
        ) : (
          <button type="button" className="workbench-icon" disabled={!dirty} onClick={() => void save()}>
            {tr("保存", "Save")}
          </button>
        )}
        {dirty ? (
          <span className="workbench-status">
            {tr("未保存草稿仅在本次会话保留", "Unsaved draft stays in this session")}
          </span>
        ) : null}
      </div>
      {mode === "edit" ? (
        <textarea
          className="workbench-editor"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          spellCheck={false}
        />
      ) : (
        <pre className="workbench-code" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

function DocxPane({ data, onOpenNative }) {
  const { tr } = useI18n();
  const host = useRef(null);
  useEffect(() => {
    const node = host.current;
    if (!node) return undefined;
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    node.replaceChildren();
    void renderAsync(blob, node, undefined, {
      inWrapper: true,
      useBase64URL: true,
      ignoreFonts: true,
      ignoreWidth: true,
      ignoreHeight: true,
      breakPages: false,
    }).then(() => {
      node.querySelectorAll("script,iframe,object,embed,link[rel='stylesheet']").forEach((item) => item.remove());
      node.querySelectorAll("a").forEach((item) => {
        const href = item.getAttribute("href") || "";
        if (!href.startsWith("#")) item.setAttribute("href", "#");
      });
      node.querySelectorAll("img").forEach((item) => {
        const src = item.getAttribute("src") || "";
        if (src && !src.startsWith("data:")) item.remove();
      });
    });
    return undefined;
  }, [data]);
  return (
    <div className="workbench-docx">
      <div className="workbench-docx-note">
        <span>{tr("近似预览，复杂排版可能与 Word 不一致。", "Approximate preview. Complex layout may differ from Word.")}</span>
        <button type="button" className="workbench-toolbar-btn" onClick={onOpenNative}>
          {tr("打开原文件", "Open original")}
        </button>
      </div>
      <div className="workbench-docx-scroll">
        <div className="workbench-docx-page" ref={host} />
      </div>
    </div>
  );
}

const TERMINAL_THEME = {
  background: "#141217",
  foreground: "#f6f1fa",
  cursor: "#f6f1fa",
  cursorAccent: "#141217",
  selectionBackground: "#6ba8d8",
  selectionForeground: "#141217",
  black: "#5a5460",
  red: "#ff8b92",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#8bb4ff",
  magenta: "#d0b4ff",
  cyan: "#7dcfff",
  white: "#f6f1fa",
  brightBlack: "#8a8490",
  brightRed: "#ffb0b5",
  brightGreen: "#c6f08a",
  brightYellow: "#f4d08a",
  brightBlue: "#adc8ff",
  brightMagenta: "#e2ccff",
  brightCyan: "#b4f0ff",
  brightWhite: "#ffffff",
};

function displayBrowserUrl(url) {
  return !url || url === "about:blank" ? "" : url;
}

function hasHttpScheme(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function consoleKind(type) {
  const value = String(type || "info").toLowerCase();
  if (value === "error" || value === "download") return "error";
  if (value === "warning" || value === "warn" || value === "popup") return "warn";
  if (value === "network") return "network";
  return "info";
}

function BrowserPane({ tab, resource, workbench, covered }) {
  const { tr } = useI18n();
  const host = useRef(null);
  const [url, setUrl] = useState(() => displayBrowserUrl(resource?.url));
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [logs, setLogs] = useState([]);
  useEffect(() => {
    setUrl(displayBrowserUrl(resource?.url));
  }, [resource?.url]);
  useEffect(() => {
    if (!resource) {
      void workbench.hideBrowser();
      return undefined;
    }
    const node = host.current;
    if (!node) return undefined;
    let frame = 0;
    let cancelled = false;
    const send = () => {
      if (cancelled) return;
      const box = node.getBoundingClientRect();
      void workbench.layoutBrowser(
        tab.id,
        { x: box.x, y: box.y, width: box.width, height: box.height },
        !covered && box.width > 8 && box.height > 8,
      );
    };
    const observe = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(send);
    });
    observe.observe(node);
    frame = window.requestAnimationFrame(() => window.requestAnimationFrame(send));
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      observe.disconnect();
      void workbench.hideBrowser();
    };
  }, [tab.id, resource?.id, covered, workbench.key, consoleOpen]);

  useEffect(() => {
    if (!consoleOpen || !resource) return undefined;
    const pull = async () => {
      const result = await workbench.request({ action: "console", id: tab.id });
      if (result?.missing) return;
      const network = (result.network || []).map((item) => ({
        type: "network",
        text: `${item.status} ${item.url}`,
      }));
      setLogs([...(result.entries || []), ...network].slice(-120));
    };
    void pull().catch(() => {});
    const timer = window.setInterval(() => void pull().catch(() => {}), 700);
    return () => window.clearInterval(timer);
  }, [consoleOpen, tab.id, workbench.key]);

  const go = async (event) => {
    event.preventDefault();
    const raw = url.trim();
    if (!raw) {
      workbench.setError(tr("请输入网址，例如 bilibili.com", "Enter a web address, for example bilibili.com"));
      return;
    }
    let next = raw;
    try {
      next = normalizeBrowserUrl(raw);
    } catch (error) {
      workbench.setError(error.message);
      return;
    }
    setUrl(next);
    try {
      await workbench.request({ action: "navigate", id: tab.id, url: next });
      workbench.setError("");
    } catch (error) {
      workbench.setError(error.message);
    }
  };

  const busy = resource?.owner === "agent" || resource?.owner === "handoff";
  const showHttpsHint = Boolean(url.trim()) && !hasHttpScheme(url);
  if (!resource) {
    return <div className="workbench-file"><div className="workbench-host" /></div>;
  }
  return (
    <div className="workbench-file">
      <div className="workbench-toolbar">
        <button
          type="button"
          className="workbench-icon"
          disabled={busy}
          title={tr("后退", "Back")}
          onClick={() => workbench.request({ action: "history", id: tab.id, direction: "back" })}
        >
          ←
        </button>
        <button
          type="button"
          className="workbench-icon"
          disabled={busy}
          title={tr("前进", "Forward")}
          onClick={() => workbench.request({ action: "history", id: tab.id, direction: "forward" })}
        >
          →
        </button>
        <button
          type="button"
          className="workbench-icon"
          disabled={busy}
          title={tr("刷新", "Reload")}
          onClick={() => workbench.request({ action: "history", id: tab.id, direction: "reload" })}
        >
          ↻
        </button>
        <form className="workbench-url" onSubmit={(event) => void go(event)}>
          {showHttpsHint ? <span className="workbench-url-scheme">https://</span> : null}
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onBlur={() => {
              const raw = url.trim();
              if (!raw) return;
              try {
                setUrl(normalizeBrowserUrl(raw));
              } catch {
                /* keep the typed value until submit */
              }
            }}
            disabled={busy}
            placeholder="bilibili.com"
            aria-label={tr("网址", "Address")}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <button className="workbench-toolbar-btn" type="submit" disabled={busy}>
            {tr("前往", "Go")}
          </button>
        </form>
        {busy ? (
          <button
            type="button"
            className="workbench-toolbar-btn"
            onClick={() => workbench.request({ action: "takeover", id: tab.id })}
          >
            {tr("接管", "Take over")}
          </button>
        ) : resource?.agentUsed ? (
          <button
            type="button"
            className="workbench-toolbar-btn"
            onClick={() => workbench.request({ action: "release", id: tab.id })}
          >
            {tr("交还", "Return")}
          </button>
        ) : null}
        <button
          type="button"
          className={`workbench-toolbar-btn${consoleOpen ? " active" : ""}`}
          title={tr("控制台", "Console")}
          aria-pressed={consoleOpen}
          onClick={() => setConsoleOpen((open) => !open)}
        >
          {tr("控制台", "Console")}
        </button>
      </div>
      {resource?.status === "crashed" ? (
        <div className="workbench-status" style={{ padding: "4px 10px" }}>
          {tr("页面已崩溃", "Page crashed")}
        </div>
      ) : null}
      <div className="workbench-host" ref={host} />
      {covered ? <div className="workbench-mask" /> : null}
      {consoleOpen ? (
        <div className="workbench-console">
          <div className="workbench-console-bar">
            <strong>{tr("网页控制台", "Page console")}</strong>
            <span>{logs.length}</span>
            <button type="button" className="workbench-toolbar-btn" onClick={() => setConsoleOpen(false)}>
              {tr("关闭", "Close")}
            </button>
          </div>
          {logs.length ? (
            <div className="workbench-console-list">
              {logs.map((item, index) => (
                <div className={`workbench-console-row is-${consoleKind(item.type)}`} key={`${index}-${item.type}`}>
                  <span className="workbench-console-level">{item.type || "info"}</span>
                  <span className="workbench-console-text">{item.text}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="workbench-console-empty">{tr("暂无记录", "No entries")}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function TerminalPane({ tab, resource, workbench }) {
  const { tr } = useI18n();
  const host = useRef(null);
  const termRef = useRef(null);
  const cursor = useRef(0);
  const resourceRef = useRef(resource);
  resourceRef.current = resource;
  useEffect(() => {
    if (!resource || !host.current) return undefined;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, Consolas, "Microsoft YaHei", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      theme: TERMINAL_THEME,
      minimumContrastRatio: 7,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    termRef.current = { term, fit };
    term.onData((data) => {
      const current = resourceRef.current;
      if (current?.owner === "user" && current?.status === "running") {
        void workbench.request({ action: "write", id: tab.id, data });
      }
    });
    const pull = async () => {
      const chunk = await workbench.request({
        action: "read",
        id: tab.id,
        cursor: cursor.current,
      });
      if (chunk?.missing) return;
      if (chunk.cursorExpired) {
        term.clear();
        cursor.current = 0;
      }
      if (chunk.output) term.write(chunk.output);
      cursor.current = chunk.cursor || cursor.current;
    };
    const timer = window.setInterval(() => void pull().catch(() => {}), 120);
    const resize = () => {
      if (host.current?.clientWidth > 8) {
        fit.fit();
        void workbench.request({
          action: "resize-terminal",
          id: tab.id,
          cols: term.cols,
          rows: term.rows,
        });
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    void pull().catch(() => {});
    window.requestAnimationFrame(resize);
    return () => {
      window.clearInterval(timer);
      observer.disconnect();
      term.dispose();
    };
  }, [tab.id, resource?.id]);
  if (!resource) {
    return <div className="workbench-file"><div className="workbench-host" /></div>;
  }
  return (
    <div className="workbench-file">
      <div className="workbench-toolbar">
        <span className="workbench-status" title={resource?.cwd}>
          {resource?.cwd || tr("交互终端", "Interactive terminal")}
        </span>
        <button type="button" className="workbench-toolbar-btn" onClick={() => termRef.current?.term.reset()}>
          {tr("清屏", "Clear")}
        </button>
        <button
          type="button"
          className="workbench-toolbar-btn"
          onClick={() => workbench.request({ action: "stop", id: tab.id })}
        >
          {tr("停止", "Stop")}
        </button>
      </div>
      <div className="workbench-xterm" ref={host} />
    </div>
  );
}

function ProcessPane({ tab, resource, workbench }) {
  const { tr } = useI18n();
  const [output, setOutput] = useState("");
  const cursor = useRef(0);
  useEffect(() => {
    if (!resource) return undefined;
    const pull = async () => {
      const chunk = await workbench.request({
        action: "read",
        id: tab.id,
        cursor: cursor.current,
      });
      if (chunk?.missing) return;
      if (chunk.cursorExpired) {
        setOutput("");
        cursor.current = 0;
      }
      if (chunk.output) setOutput((current) => `${current}${chunk.output}`.slice(-200000));
      cursor.current = chunk.cursor || cursor.current;
    };
    const timer = window.setInterval(() => void pull().catch(() => {}), 250);
    void pull().catch(() => {});
    return () => window.clearInterval(timer);
  }, [tab.id, resource?.id]);
  if (!resource) {
    return <div className="workbench-file"><div className="workbench-host" /></div>;
  }
  return (
    <div className="workbench-file">
      <div className="workbench-toolbar">
        <span className="workbench-status">
          {tr("Agent 进程日志，不是交互终端。", "Agent process log, not an interactive terminal.")}
        </span>
        <button
          type="button"
          className="workbench-toolbar-btn"
          onClick={() => workbench.request({ action: "stop", id: tab.id })}
        >
          {tr("停止", "Stop")}
        </button>
        <button
          type="button"
          className="workbench-toolbar-btn"
          onClick={() =>
            workbench.request({ action: "keep", id: tab.id, value: !resource?.keepAlive })
          }
        >
          {resource?.keepAlive ? tr("取消保留", "Do not keep") : tr("保留服务", "Keep alive")}
        </button>
      </div>
      <div className="workbench-console fill">
        <div className="workbench-console-bar">
          <strong>{tr("进程输出", "Process output")}</strong>
        </div>
        <pre className="workbench-console-stream">{output || tr("暂无输出", "No output yet")}</pre>
      </div>
    </div>
  );
}


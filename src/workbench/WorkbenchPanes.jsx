import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/common";
import { TerminalPane } from "./TerminalPane.jsx";
import { FileText, GitCompare, GitBranch, Globe, TerminalSquare, MessagesSquare } from "lucide-react";
import { SideChatPane } from "./SideChatPane.jsx";
import { MarkdownPreview } from "./MarkdownPreview.jsx";
import { DocxPreview } from "./DocxPreview.jsx";
import { GitPane } from "./GitPane.jsx";
import { OCR_UI_ENABLED, OcrDialog, ocrSource } from "./OcrDialog.jsx";
import { FileExplorerPanel } from "../agent-components.jsx";
import { useI18n } from "../i18n";
import { normalizeBrowserUrl } from "../../electron/browser-url.js";
import { highlightedRows } from "./code-preview.js";
import { toWorkspaceRelativePath } from "../../electron/link-target.js";

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
  sideChat,
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
          <button type="button" className="workbench-empty-card" onClick={() => workbench.open("sidechat")}>
            <MessagesSquare size={22} strokeWidth={1.6} />
            {tr("侧边聊天", "Side chat")}
          </button>
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
          <button type="button" className="workbench-empty-card" onClick={() => workbench.open("git")}>
            <GitBranch size={22} strokeWidth={1.6} /> Git
          </button>
        </div>
      </div>
    );
  }
  if (tab.kind === "route") return builtins.route;
  if (tab.kind === "git") return <GitPane key={workbench.key} workbench={workbench} />;
  if (tab.kind === "sidechat") return <SideChatPane key={workbench.key} task={task} workbench={workbench} {...sideChat} />;
  if (tab.kind === "understanding") return builtins.understanding;
  if (tab.kind === "workspace") {
    return (
      <WorkspacePane task={task} workbench={workbench} onNotice={onNotice}>
        {builtins.workspace}
      </WorkspacePane>
    );
  }
  if (tab.kind === "file") {
    return <FilePane key={workbench.key + tab.id} tab={tab} task={task} workbench={workbench} onNotice={onNotice} />;
  }
  if (tab.kind === "image") {
    return <ImagePane key={tab.id} src={tab.src} title={tab.title} />;
  }
  if (tab.kind === "browser") {
    return <BrowserPane key={workbench.key + tab.id} tab={tab} resource={resource} workbench={workbench} covered={covered} />;
  }
  if (tab.kind === "terminal") {
    return <TerminalPane key={workbench.key + tab.id} tab={tab} resource={resource} workbench={workbench} />;
  }
  if (tab.kind === "process") {
    return <ProcessPane key={workbench.key + tab.id} tab={tab} resource={resource} workbench={workbench} />;
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
    let cancelled = false;
    if (!query.trim()) {
      setHits(null);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      workbench
        .request({ action: "search", query })
        .then((result) => { if (!cancelled) setHits(result); })
        .catch((error) => { if (!cancelled) onNotice(error.message); });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
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

export function FilePane({ tab, task, workbench, onNotice, previewOnly = false }) {
  const { tr, language } = useI18n();
  const filePath = toWorkspaceRelativePath(task.workspacePath, tab.path) || tab.path;
  const ext = extensionOf(filePath);
  const [payload, setPayload] = useState(null);
  const [failure, setFailure] = useState("");
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const loadGeneration = useRef(0);
  const editMirror = useRef(null);
  const latestContent = useRef("");
  const [mode, setMode] = useState("read");
  const [content, setContent] = useState("");
  latestContent.current = content;
  const [saved, setSaved] = useState("");
  const [query, setQuery] = useState("");
  const isMarkdown = ext === "md" || ext === "markdown";
  const dirty = content !== saved;
  const languageName =
    (LANG[ext] && hljs.getLanguage(LANG[ext]) && LANG[ext]) || "plaintext";
  const html = useMemo(() => {
    const highlighted = hljs.highlight(content || " ", {
      language: languageName,
      ignoreIllegals: true,
    }).value;
    const lines = (content || "").split("\n");
    const needle = query.trim().toLowerCase();
    return highlightedRows(highlighted).map((line, index) => {
      const plain = lines[index] || "";
      const mark =
        (needle && plain.toLowerCase().includes(needle)) || tab.line === index + 1
          ? " mark"
          : "";
      return `<div class="workbench-code-line${mark}"><span class="wb-gutter">${index + 1}</span><span class="wb-code-src">${line || " "}</span></div>`;
    }).join("");
  }, [content, languageName, query, tab.line]);

  const loadFile = async (approveExternal = false) => {
    const generation = ++loadGeneration.current;
    setFailure("");
    setPayload(null);
      try {
        const file = IMAGE_EXT.has(ext) || ext === "docx" || ext === "pdf" || approveExternal
          ? await workbench.request({ action: "file", path: filePath, approveExternal })
          : null;
        if (generation !== loadGeneration.current) return;
        if (["image", "docx", "pdf"].includes(file?.kind)) { setPayload(file); return; }
        const preview = file?.readOnly ? file : await window.desktop.workspace.readPreview(task.workspacePath, filePath);
        if (generation !== loadGeneration.current) return;
        setPayload({ kind: preview.binary ? "binary" : "text", ...preview });
        const next = preview.binary ? "" : preview.content || "";
        const draft = previewOnly ? null : workbench.draft(tab.id);
        setSaved(next);
        setContent(typeof draft === "string" ? draft : next);
        if (typeof draft === "string" && draft !== next) {
          workbench.dirty.current.add(tab.id);
          setMode("edit");
        } else setMode("read");
      } catch (error) {
        if (generation === loadGeneration.current) setFailure(error.message);
      }
  };
  useEffect(() => {
    void loadFile();
    return () => { loadGeneration.current += 1; };
  }, [tab.id, tab.path, filePath, tab.revision, task.workspacePath, reload]);

  useEffect(() => {
    if (!payload || previewOnly) return;
    if (dirty) workbench.dirty.current.add(tab.id);
    else workbench.dirty.current.delete(tab.id);
    if (mode === "edit") workbench.saveDraft(tab.id, content);
  }, [content, dirty, mode, tab.id, payload]);

  const save = async () => {
    if (previewOnly || saving || payload?.readOnly || payload?.truncated) return;
    setSaving(true); setFailure("");
    const submitted = content;
    try {
    const result = await window.desktop.workspace.saveText({
      workspacePath: task.workspacePath,
      requestedPath: filePath,
      content,
      expectedContent: saved,
    });
    setSaved(result.content);
    if (latestContent.current === submitted) {
      setContent(result.content);
      workbench.saveDraft(tab.id, null);
      workbench.dirty.current.delete(tab.id);
    }
    onNotice(tr("已保存 {path}", "Saved {path}", { path: result.path }));
    } catch (error) { setFailure(error.message); }
    finally { setSaving(false); }
  };

  const openNative = () => {
    void window.desktop?.links?.activate({
      href: filePath,
      action: "open",
      workspacePath: task.workspacePath,
      language,
    }).catch((error) => setFailure(error.message));
  };

  if (!payload) {
    return <div className="workbench-notice">
      {failure ? <><p role="alert">{failure}</p>
        <button className="workbench-toolbar-btn" onClick={() => setReload((n) => n + 1)}>{tr("重试", "Retry")}</button>
        {/^[a-z]:[/\\]|^\//i.test(filePath) && <button className="workbench-toolbar-btn" onClick={() => void loadFile(true)}>{tr("授权只读预览此文件", "Authorize read-only preview")}</button>}
      </> : tr("正在打开文件", "Opening file")}
    </div>;
  }
  if (payload.kind === "image") {
    return <ImagePane src={`data:${payload.mime};base64,${payload.data}`} title={tab.title} />;
  }
  if (payload.kind === "docx") {
    return <DocxPreview data={payload.data} onOpenNative={openNative} workbench={workbench} />;
  }
  if (payload.kind === "pdf") return <PdfOcrPane data={payload.data} name={tab.title || filePath} onOpenNative={openNative} />;
  if (payload.binary) {
    return (
      <div className="workbench-notice">
        {tr("此文件不能作为文本预览。", "This file cannot be previewed as text.")}
      </div>
    );
  }

  return (
    <div className="workbench-file">
      {failure && <div role="alert" className="workbench-error">{failure}</div>}
      <div className="workbench-toolbar document-toolbar">
        <span className="workbench-status document-path" title={filePath}>{filePath}</span>
        {isMarkdown && <><button className="workbench-toolbar-btn" aria-pressed={mode === "read"} onClick={() => setMode("read")}>{tr("阅读", "Read")}</button><button className="workbench-toolbar-btn" aria-pressed={mode === "source"} onClick={() => setMode("source")}>{tr("源码", "Source")}</button></>}
        {(!isMarkdown || mode !== "read") && <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tr("搜索", "Search")}
        />}
        {previewOnly ? null : mode !== "edit" ? (
          <button type="button" className="workbench-toolbar-btn" disabled={payload.readOnly || payload.truncated} onClick={() => setMode("edit")}>
            {tr("编辑", "Edit")}
          </button>
        ) : (
          <button type="button" className="workbench-toolbar-btn" disabled={!dirty || saving || payload.readOnly || payload.truncated} onClick={() => void save()}>
            {tr("保存", "Save")}
          </button>
        )}
        {dirty ? (
          <span className="workbench-status">
            {tr("未保存草稿仅在本次会话保留", "Unsaved draft stays in this session")}
          </span>
        ) : null}
      </div>
      {(payload.readOnly || payload.truncated) && <div className="workbench-search-hint">{tr("只读预览；截断内容不能覆盖原文件。", "Read-only preview; truncated content cannot overwrite the file.")}</div>}
      {mode === "edit" ? (
        <div className="workbench-code-editor">
        <pre ref={editMirror} className="workbench-code editor-mirror" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
        <textarea
          className="workbench-editor"
          aria-label={tr("代码编辑器", "Code editor")}
          wrap="off"
          value={content}
          onScroll={(event) => {
            if (editMirror.current) { editMirror.current.scrollTop = event.target.scrollTop; editMirror.current.scrollLeft = event.target.scrollLeft; }
          }}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "s") { event.preventDefault(); void save(); } }}
          spellCheck={false}
        />
        </div>
      ) : isMarkdown && mode === "read" ? <MarkdownPreview content={content} path={filePath} workbench={workbench} onError={setFailure} /> : (
        <pre className="workbench-code" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

function ImagePane({ src, title }) {
  const { tr } = useI18n();
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [size, setSize] = useState(null);
  const [failed, setFailed] = useState(false);
  const [ocrOpen, setOcrOpen] = useState(false);
  return <div className="workbench-file">
    <div className="workbench-toolbar">
      {OCR_UI_ENABLED && window.desktop?.ocr && ocrSource({ src, name: title }) && <button className="workbench-toolbar-btn" onClick={() => setOcrOpen(true)}>{tr("识别文字", "Recognize text")}</button>}
      <button className="workbench-toolbar-btn" onClick={() => { setFit(true); setZoom(1); }}>{tr("适应", "Fit")}</button>
      <button className="workbench-toolbar-btn" onClick={() => { setFit(false); setZoom(1); }}>{tr("原始", "Original")}</button>
      <button className="workbench-icon" aria-label={tr("缩小", "Zoom out")} onClick={() => { setFit(false); setZoom((z) => Math.max(0.25, z - 0.25)); }}>−</button>
      <button className="workbench-icon" aria-label={tr("放大", "Zoom in")} onClick={() => { setFit(false); setZoom((z) => Math.min(4, z + 0.25)); }}>+</button>
      <span className="workbench-status">{fit ? tr("适应窗口", "Fit") : Math.round(zoom * 100) + "%"}{size ? ` · ${size.width} × ${size.height}` : ""}</span>
    </div>
    {failed ? <div role="alert" className="workbench-error">{tr("图片已失效或无法读取，请重新添加附件。", "Image unavailable. Please attach it again.")}</div> :
      <div className="workbench-image" data-fit={fit ? "contain" : "original"}>
        <img src={src} alt={title} onError={() => setFailed(true)}
          onLoad={(event) => setSize({ width: event.target.naturalWidth, height: event.target.naturalHeight })}
          style={!fit && size ? { width: size.width * zoom, maxWidth: "none", maxHeight: "none" } : undefined} />
      </div>}
    {OCR_UI_ENABLED && ocrOpen && <OcrDialog source={ocrSource({ src, name: title })} onClose={() => setOcrOpen(false)} />}
  </div>;
}

function PdfOcrPane({ data, name, onOpenNative }) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(false);
  return <div className="workbench-notice"><p>{name}</p><p>{tr("可提取文字层或识别扫描页面，并逐页核对原文。", "Extract text or recognize scanned pages, with source page review.")}</p><button className="workbench-toolbar-btn" onClick={onOpenNative}>{tr("系统打开 PDF", "Open PDF externally")}</button>{OCR_UI_ENABLED && window.desktop?.ocr && <button className="workbench-toolbar-btn" onClick={() => setOpen(true)}>{tr("读取 / 识别文字", "Read / recognize text")}</button>}{OCR_UI_ENABLED && open && <OcrDialog source={{ base64: data, name }} onClose={() => setOpen(false)} />}</div>;
}

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
  useLayoutEffect(() => {
    if (!resource) {
      void workbench.hideBrowser();
      return undefined;
    }
    const node = host.current;
    if (!node) return undefined;
    let frame = 0;
    let cancelled = false;
    const send = (attempt = 0) => {
      if (cancelled) return;
      const box = node.getBoundingClientRect();
      if (covered) {
        void workbench.hideBrowser();
        return;
      }
      if (box.width <= 8 || box.height <= 8) {
        if (attempt < 8) {
          window.cancelAnimationFrame(frame);
          frame = window.requestAnimationFrame(() => send(attempt + 1));
        }
        return;
      }
      void workbench.layoutBrowser(
        tab.id,
        { x: box.x, y: box.y, width: box.width, height: box.height },
        true,
      ).then((result) => {
        if (cancelled || result?.missing) return;
        if (result === false && attempt < 8) {
          window.cancelAnimationFrame(frame);
          frame = window.requestAnimationFrame(() => send(attempt + 1));
        }
      });
    };
    const observe = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => send(0));
    });
    observe.observe(node);
    send();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      observe.disconnect();
      void workbench.hideBrowser();
    };
  }, [tab.id, resource?.id, covered, workbench.key, consoleOpen]);

  useEffect(() => {
    if (!consoleOpen || !resource) return undefined;
    let disposed = false, reading = false;
    const pull = async () => {
      if (disposed || reading) return;
      reading = true;
      try {
      const result = await workbench.request({ action: "console", id: tab.id });
      if (disposed || result?.missing) return;
      const network = (result.network || []).map((item) => ({
        type: "network",
        text: `${item.status} ${item.url}`,
      }));
      setLogs([...(result.entries || []), ...network].slice(-120));
      } catch (error) { if (!disposed) workbench.setError(error.message); }
      finally { reading = false; }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 700);
    return () => { disposed = true; window.clearInterval(timer); };
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
          onClick={() => workbench.request({ action: "history", id: tab.id, direction: "back" }).catch((error) => workbench.setError(error.message))}
        >
          ←
        </button>
        <button
          type="button"
          className="workbench-icon"
          disabled={busy}
          title={tr("前进", "Forward")}
          onClick={() => workbench.request({ action: "history", id: tab.id, direction: "forward" }).catch((error) => workbench.setError(error.message))}
        >
          →
        </button>
        <button
          type="button"
          className="workbench-icon"
          disabled={busy}
          title={tr("刷新", "Reload")}
          onClick={() => workbench.request({ action: "history", id: tab.id, direction: "reload" }).catch((error) => workbench.setError(error.message))}
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
            onClick={() => workbench.request({ action: "takeover", id: tab.id }).catch((error) => workbench.setError(error.message))}
          >
            {tr("接管", "Take over")}
          </button>
        ) : resource?.agentUsed ? (
          <button
            type="button"
            className="workbench-toolbar-btn"
            onClick={() => workbench.request({ action: "release", id: tab.id }).catch((error) => workbench.setError(error.message))}
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

function ProcessPane({ tab, resource, workbench }) {
  const { tr } = useI18n();
  const [output, setOutput] = useState("");
  const cursor = useRef(0);
  useEffect(() => {
    if (!resource) return undefined;
    let disposed = false, reading = false;
    cursor.current = 0;
    setOutput("");
    const pull = async () => {
      if (disposed || reading) return;
      reading = true;
      try {
      const chunk = await workbench.request({
        action: "read",
        id: tab.id,
        cursor: cursor.current,
      });
      if (disposed || chunk?.missing) return;
      if (chunk.cursorExpired) {
        setOutput("");
        cursor.current = 0;
      }
      if (chunk.output) setOutput((current) => `${current}${chunk.output}`.slice(-200000));
      cursor.current = chunk.cursor || cursor.current;
      } catch (error) { if (!disposed) workbench.setError(error.message); }
      finally { reading = false; }
    };
    const timer = window.setInterval(() => void pull(), 250);
    void pull();
    return () => { disposed = true; window.clearInterval(timer); };
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
          disabled={resource.status === "exited"}
          onClick={() => workbench.request({ action: "stop", id: tab.id }).catch((error) => workbench.setError(error.message))}
        >
          {tr("停止", "Stop")}
        </button>
        <button
          type="button"
          className="workbench-toolbar-btn"
          onClick={() =>
            workbench.request({ action: "keep", id: tab.id, value: !resource?.keepAlive }).catch((error) => workbench.setError(error.message))
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

import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { useI18n } from "../i18n";
import "./document-preview.css";

// A separate same-origin document has its own restrictive CSP. srcdoc would
// inherit the application's style-src 'self' and silently lose DOCX styles.
const FRAME_URL = new URL("document-preview.html", document.baseURI).href;

// Create all document nodes in the sandboxed frame, not the application DOM.
function safeNode(doc, item) {
  if (typeof item === "string") return doc.createTextNode(item);
  if (item?.nodeType) return item;
  const { ns, tagName, className, style, children, ...props } = item;
  if (tagName === "#fragment") return doc.createDocumentFragment();
  if (tagName === "#comment") return doc.createComment("");
  if (/^(script|iframe|object|embed|link|meta|base)$/i.test(tagName)) return doc.createTextNode("");
  const node = ns ? doc.createElementNS(ns, tagName) : doc.createElement(tagName);
  if (className) node.setAttribute("class", className);
  if (style) typeof style === "string" ? node.setAttribute("style", style) : Object.assign(node.style, style);
  for (const [key, value] of Object.entries(props)) {
    if (/^on|innerHTML|outerHTML|srcdoc/i.test(key)) continue;
    if (value !== undefined) node[key] = value;
  }
  children?.forEach((child) => node.appendChild(safeNode(doc, child)));
  return node;
}

export function DocxPreview({ data, onOpenNative, workbench }) {
  const { tr } = useI18n();
  const frame = useRef(null), dimensions = useRef(800);
  const [ready, setReady] = useState(0), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [mode, setMode] = useState("fit"), [zoom, setZoom] = useState(1), [scale, setScale] = useState(1), [rendered, setRendered] = useState(0);
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!ready || !doc?.getElementById("pages")) return;
    let disposed = false;
    const pages = doc.getElementById("pages");
    // Each generation renders into its own container: a late render cannot
    // replace another document after the user switches tabs or retries.
    const container = doc.createElement("div");
    pages.replaceChildren(container); setLoading(true); setError("");
    const click = (event) => {
      const anchor = event.target.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href") || "";
      if (href.startsWith("#")) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(href)) void workbench.openHref(href).catch((failure) => { if (!disposed) setError(failure.message); });
    };
    doc.addEventListener("click", click);
    Promise.resolve().then(() => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      return renderAsync(bytes.buffer, container, container, {
        inWrapper: true, useBase64URL: true, ignoreFonts: false, ignoreWidth: false, ignoreHeight: false,
        breakPages: true, ignoreLastRenderedPageBreak: false, renderAltChunks: false,
        h: (item) => safeNode(doc, item),
      });
    }).then(() => {
      if (disposed) return;
      dimensions.current = Math.max(240, ...[...container.querySelectorAll("section.docx")].map((node) => node.offsetWidth + 32));
      setRendered((n) => n + 1);
    }).catch((failure) => { if (!disposed) setError(tr("无法预览 Word 文档：", "Cannot preview Word document: ") + failure.message); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; doc.removeEventListener("click", click); container.remove(); };
  }, [data, ready]);
  useEffect(() => {
    const element = frame.current, pages = element?.contentDocument?.getElementById("pages");
    if (!pages) return;
    const resize = () => {
      const next = mode === "fit" ? Math.min(1, Math.max(.1, (element.clientWidth - 16) / dimensions.current)) : zoom;
      pages.style.zoom = String(next); setScale(next);
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    return () => observer.disconnect();
  }, [ready, rendered, mode, zoom]);
  return <div className="workbench-document">
    <div className="workbench-toolbar document-toolbar">
      <button className="workbench-toolbar-btn" aria-pressed={mode === "fit"} onClick={() => setMode("fit")}>{tr("适应宽度", "Fit width")}</button>
      <button className="workbench-toolbar-btn" aria-pressed={mode === "original"} onClick={() => { setMode("original"); setZoom(1); }}>{tr("原始页面", "Original pages")}</button>
      <button className="workbench-toolbar-btn" aria-label={tr("缩小文档", "Zoom out document")} onClick={() => { setMode("custom"); setZoom(Math.max(.25, scale - .1)); }}>−</button>
      <span className="workbench-status">{Math.round(scale * 100)}%</span>
      <button className="workbench-toolbar-btn" aria-label={tr("放大文档", "Zoom in document")} onClick={() => { setMode("custom"); setZoom(Math.min(2, scale + .1)); }}>+</button>
      <button className="workbench-toolbar-btn" onClick={onOpenNative}>{tr("打开原文件", "Open original")}</button>
    </div>
    <div className="workbench-search-hint">{tr("保留文档样式的近似预览；复杂排版请用 Word / WPS 查看。", "Styled preview; use Word / WPS for exact complex layout.")}</div>
    {loading && <div className="workbench-search-hint">{tr("正在排版文档…", "Rendering document…")}</div>}
    {error && <div className="workbench-error" role="alert">{error}<button className="workbench-toolbar-btn" onClick={() => setReady((n) => n + 1)}>{tr("重试", "Retry")}</button></div>}
    <iframe className="workbench-docx-frame" ref={frame} title={tr("Word 文档预览", "Word document preview")} sandbox="allow-same-origin" src={FRAME_URL} onLoad={() => setReady((n) => n + 1)} />
  </div>;
}

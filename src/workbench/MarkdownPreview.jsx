import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/common";
import { classifyLink } from "../../electron/link-target.js";
import { useI18n } from "../i18n";
import "./document-preview.css";

export function documentLink(path, href) {
  const link = classifyLink(href);
  if (!link || link.kind !== "file") return link;
  const [target, fragment] = link.target.split("#", 2);
  if (/^(?:[a-z]:\/|\/)/i.test(target)) return { ...link, target, fragment };
  const parts = String(path).replaceAll("\\", "/").split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== ".." && !/^[a-z]:$/i.test(parts.at(-1))) parts.pop();
    else parts.push(part);
  }
  return { ...link, target: parts.join("/"), fragment };
}

function headingIds() {
  return (tree) => {
    const counts = new Map();
    const text = (node) => node.value || (node.children || []).map(text).join("");
    const visit = (node) => {
      if (node.type === "heading") {
        const slug = text(node).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-") || "section";
        const count = counts.get(slug) || 0; counts.set(slug, count + 1);
        node.data = { ...node.data, hProperties: { id: slug + (count ? "-" + count : "") } };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

function MarkdownImage({ src, alt, path, workbench }) {
  const { tr } = useI18n();
  const [url, setUrl] = useState(""), [error, setError] = useState("");
  const [approved, setApproved] = useState(false), [loading, setLoading] = useState(false);
  const link = useMemo(() => documentLink(path, src), [path, src]);
  useEffect(() => {
    let disposed = false;
    setUrl(""); setError(""); setLoading(false);
    if (!link) { setError(tr("图片地址不可用", "Invalid image URL")); return; }
    if (link.kind === "web") return;
    if (link.kind !== "file") return;
    setLoading(true);
    workbench.request({ action: "file", path: link.target, approveExternal: approved }).then((file) => {
      if (file.kind !== "image") throw new Error(tr("不支持此图片格式", "Unsupported image format"));
      if (!disposed) setUrl(`data:${file.mime};base64,${file.data}`);
    }).catch((failure) => { if (!disposed) setError(failure.message); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [link, approved, workbench.key]);
  if (url && !error) return <img src={url} alt={alt || ""} loading="lazy" onError={() => setError(tr("图片加载失败", "Image failed to load"))} onDoubleClick={() => workbench.openImage(url, alt)} />;
  return <span className="document-image-placeholder"><span>{alt || tr("图片", "Image")}{loading ? " · …" : error ? " · " + error : ""}</span>{!loading && !approved && <button type="button" onClick={() => {
    if (link?.kind === "web") void workbench.openHref(link.href).catch((failure) => setError(failure.message));
    else setApproved(true);
  }}>{link?.kind === "web" ? tr("打开远程图片", "Open remote image") : tr("授权读取图片", "Authorize image")}</button>}</span>;
}

export function MarkdownPreview({ content, path, workbench, onError }) {
  const root = useRef(null), latest = useRef({ path, workbench, onError });
  latest.current = { path, workbench, onError };
  const components = useMemo(() => ({
    code: ({ className, children }) => {
      const language = className?.replace("language-", "");
      return language && hljs.getLanguage(language) ? <code className={className} dangerouslySetInnerHTML={{ __html: hljs.highlight(String(children), { language }).value }} /> : <code className={className}>{children}</code>;
    },
    a: ({ href, children }) => <a href={href} onClick={async (event) => {
      event.preventDefault();
      const { path: currentPath, workbench: wb, onError: report } = latest.current;
      try {
        const link = documentLink(currentPath, href);
        if (link?.kind === "anchor") {
          const id = decodeURIComponent(link.href.slice(1));
          const heading = [...root.current.querySelectorAll("[id]")].find((node) => node.id === id);
          if (heading) heading.scrollIntoView({ block: "start" });
          else throw new Error("未找到此标题。");
        } else if (link?.kind === "file") wb.openFile(link.target, link.line || 1);
        else if (!link || !await wb.openHref(link.href)) throw new Error("无法打开此链接。");
      } catch (error) { report?.(error.message); }
    }}>{children}</a>,
    img: ({ src, alt }) => <MarkdownImage key={latest.current.path + ":" + src} src={src} alt={alt} path={latest.current.path} workbench={latest.current.workbench} />,
  }), []);
  return <article ref={root} className="workbench-markdown" aria-label="Markdown 阅读视图"><ReactMarkdown remarkPlugins={[remarkGfm, headingIds]} urlTransform={(url) => classifyLink(url) ? url : ""} components={components}>{content}</ReactMarkdown></article>;
}

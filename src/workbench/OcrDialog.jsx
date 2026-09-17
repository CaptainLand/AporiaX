import { useEffect, useRef, useState } from "react";
import { SideChatDialog } from "./SideChatDialog.jsx";
import { useI18n } from "../i18n";
import "./side-chat.css";
import "./ocr.css";

export function ocrSource(value) {
  if (value.hash) return { hash: value.hash, name: value.name };
  const src = value.dataUrl || value.src || "";
  if (src.startsWith("aporiax-blob://")) return { hash: src.slice(15).replace(/\/$/, ""), name: value.name };
  const match = src.match(/^data:(?:image\/(?:png|jpeg|webp)|application\/pdf);base64,(.+)$/s);
  return match ? { base64: match[1], name: value.name } : null;
}
function resultText(job) {
  return `来源：${job.name}（本地识别；状态：${job.state}；请核对原页）\n\n` + job.pages.map((page) => `[${job.name} · 第 ${page.page} 页 · ${page.method === "text-layer" ? "文字层" : "OCR"}]\n${page.text}${page.error ? `\n[未完成：${page.error}]` : !page.text.trim() ? "\n[无正文]" : ""}`).join("\n\n");
}
export function OcrDialog({ source: initialSource, onClose, onAttach }) {
  const { tr } = useI18n();
  const [source, setSource] = useState(initialSource), [resource, setResource] = useState(null), [job, setJob] = useState(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [from, setFrom] = useState(1), [to, setTo] = useState(1), [pageIndex, setPageIndex] = useState(0), [language, setLanguage] = useState("chi_sim+eng");
  const [forceOcr, setForceOcr] = useState(false);
  const [rotation, setRotation] = useState(0), [notice, setNotice] = useState("");
  const active = useRef(true), jobRef = useRef(null), pending = useRef(false);
  const request = (operation, extra = {}) => window.desktop.ocr.request({ operation, ...extra });
  useEffect(() => {
    active.current = true;
    request("status").then((value) => { if (active.current) setResource(value); }).catch((failure) => { if (active.current) setError(failure.message); });
    return () => { active.current = false; if (jobRef.current) void request("cancel", { id: jobRef.current }).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (job?.state !== "running") return;
    let disposed = false, timer;
    const poll = async () => {
      try { const value = await request("get", { id: job.id }); if (!disposed) setJob(value); }
      catch (failure) { if (!disposed) { setError(failure.message); setJob((current) => ({ ...current, state: "failed" })); } }
      if (!disposed) timer = setTimeout(poll, 1000);
    };
    timer = setTimeout(poll, 500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [job?.id, job?.state]);
  async function act(operation) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await request(operation, { id: job?.id, source, from: Number(from), to: Number(to), language, rotation, forceOcr });
      if (operation === "start") {
        jobRef.current = result.id;
        if (!active.current) { await request("cancel", { id: result.id }); return; }
      }
      if (!active.current) return;
      if (operation === "prepare") setResource(result);
      if (operation === "start" || operation === "cancel") { setJob(result); setPageIndex(0); }
      if (operation === "copy") setNotice(tr("已复制文本。", "Text copied."));
      if (operation === "save" && result.path) setNotice(tr("已保存：", "Saved: ") + result.path);
    } catch (failure) { if (active.current) setError(failure.message); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  const running = busy || job?.state === "running", page = job?.pages[pageIndex];
  const states = { running: tr("识别中", "Recognizing"), completed: tr("已完成", "Completed"), partial: tr("部分完成，请核对失败页", "Partially completed; review failed pages"), failed: tr("识别失败", "Failed"), cancelled: tr("已取消，保留已处理页", "Cancelled; processed pages retained") };
  const actions = job?.pages.length > 0 && <div className="ocr-actions"><button disabled={running} onClick={() => void act("copy")}>{tr("复制全部文本", "Copy all text")}</button><button disabled={running} onClick={() => void act("save")}>{tr("另存文本", "Save text")}</button>{onAttach && <button disabled={running || !job.pages.some((value) => value.text)} onClick={() => { const content = resultText(job); const accepted = onAttach({ id: crypto.randomUUID(), kind: "document", type: "text/plain", format: "OCR", name: `${job.name}.ocr.txt`, content, size: new TextEncoder().encode(content).length, pageCount: job.pages.length, requiresOcr: false, truncated: job.state !== "completed" }); if (accepted !== false) onClose(); }}>{tr("加入对话附件", "Attach to conversation")}</button>}</div>;
  return <SideChatDialog title={tr("本地文字识别", "Local OCR")} subtitle={tr("不上传文件。识别文本可复制、另存或由你选择加入对话。", "Files stay local. Copy, save, or explicitly attach recognized text.")} onClose={onClose} footer={actions}>
    <div className="ocr-panel">
      <label>{tr("图片或 PDF（16 MiB 内）", "Image or PDF (up to 16 MiB)")}<input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" disabled={running} onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 16 * 1024 * 1024) { setError(tr("文件超过 16 MiB。", "File exceeds 16 MiB.")); return; } const bytes = await file.arrayBuffer(); if (active.current) { setSource({ name: file.name, data: bytes }); setJob(null); setFrom(1); setTo(1); } }} /></label>
      {source && <strong className="ocr-source-name">{source.name}</strong>}
      {resource && !resource.ready && <div className="ocr-resource"><p>{tr("首次需要下载约 4.7 MB 中英文资源；仅下载引擎数据，不上传文件。", "Download about 4.7 MB of English/Chinese language resources once. No file uploads.")}</p><button disabled={running} onClick={() => void act("prepare")}>{busy ? tr("正在下载…", "Downloading…") : tr("下载本地识别资源", "Download OCR resources")}</button></div>}
      <div className="ocr-controls"><label>{tr("起始页", "From")}<input type="number" min={1} max={240} value={from} disabled={running} onChange={(event) => setFrom(event.target.value)} /></label><label>{tr("结束页", "To")}<input type="number" min={1} max={240} value={to} disabled={running} onChange={(event) => setTo(event.target.value)} /></label><label>{tr("语言", "Language")}<select value={language} disabled={running} onChange={(event) => setLanguage(event.target.value)}><option value="chi_sim+eng">中文 + English</option><option value="eng">English</option><option value="chi_sim">简体中文</option></select></label></div>
      <small>{tr("每次最多 20 页，图片填 1–1。PDF 优先读取已有文字层。", "Up to 20 pages; use 1–1 for images. PDF text layers are reused.")}</small>
      <label><input type="checkbox" checked={forceOcr} disabled={running} onChange={(event) => setForceOcr(event.target.checked)} />{tr("强制识别图像文字（保留原文字层）", "Force OCR (retain the original text layer)")}</label>
      <label>{tr("顺时针旋转扫描内容", "Rotate scan clockwise")}<select value={rotation} disabled={running} onChange={(event) => setRotation(Number(event.target.value))}>{[0, 90, 180, 270].map((angle) => <option key={angle} value={angle}>{angle}°</option>)}</select></label>
      <div className="ocr-actions"><button disabled={running || !source || !resource?.ready} onClick={() => void act("start")}>{tr("开始识别", "Recognize")}</button>{job?.state === "running" && <button disabled={busy} onClick={() => void act("cancel")}>{tr("取消识别", "Cancel")}</button>}</div>
      {(error || job?.error) && <p role="alert" className="workbench-error">{error || job.error}</p>}
      {notice && <p role="status">{notice}</p>}
      {job && <p role="status">{states[job.state]} · {job.completed}/{job.total}{job.state === "running" && job.page ? ` · ${tr("第", "Page")} ${job.page} · ${Math.round((job.progress || 0) * 100)}%` : ""}{job.cached ? tr(" · 已复用本次会话缓存", " · Session cache") : ""}</p>}
      {job?.pages.length > 0 && <><label>{tr("核对页面", "Review page")}<select aria-label={tr("结果页", "Result page")} value={pageIndex} onChange={(event) => setPageIndex(Number(event.target.value))}>{job.pages.map((value, index) => <option key={value.page} value={index}>{tr("第", "Page")} {value.page}{value.error ? " ⚠" : ""}</option>)}</select></label>
        <div className="ocr-result">{page?.preview && <img alt={tr("原页预览", "Source page preview")} src={`data:image/jpeg;base64,${page.preview}`} />}<div><p>{page?.method === "text-layer" ? tr("来自原始文字层", "Original text layer") : tr("OCR 文本，请核对", "OCR text; please verify")}{page?.confidence == null ? "" : ` · ${tr("引擎置信度", "Engine confidence")} ${Math.round(page.confidence)}%`}</p>{page?.error && <p role="alert">{page.error}</p>}<pre>{page?.text || tr("未识别到正文", "No text recognized")}</pre></div></div>
      </>}
    </div>
  </SideChatDialog>;
}

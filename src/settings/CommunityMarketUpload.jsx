import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";

export function formatMarketQuota(quota, tr, language) {
  if (!quota) return tr("每周最多投稿 3 次，剩余额度以服务端为准。", "Up to 3 submissions per week. The server tracks your remaining quota.");
  const reset = new Intl.DateTimeFormat(language, {
    timeZone: "Asia/Shanghai", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(quota.resetsAt));
  return tr("本周剩余 {left} / {limit} 次 · {reset} 重置（北京时间）",
    "{left} of {limit} submissions left this week · Resets {reset} (Beijing time)",
    { left: quota.remaining, limit: quota.limit, reset });
}

export function CommunityMarketUpload({ owner, api, tr, language, kindLabels, describeError, retryKeys, blocked, onBusy, onSubmitted, onClose }) {
  const [attempt, setAttempt] = useState(0);
  const [options, setOptions] = useState(null);
  const [optionsError, setOptionsError] = useState("");
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [downloadAllowed, setDownloadAllowed] = useState(false);
  const [consent, setConsent] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false), mounted = useRef(false), previewSequence = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; previewSequence.current++; }; }, []);
  useEffect(() => {
    let active = true;
    setOptions(null); setOptionsError("");
    Promise.resolve().then(() => api.uploadOptions(owner)).then(value => { if (active) setOptions(value); })
      .catch(failure => { if (active) setOptionsError(describeError(failure, tr)); });
    return () => { active = false; };
  }, [api, owner, tr, attempt, describeError]);
  async function choose(id) {
    const expected = ++previewSequence.current;
    setSelected(id); setPreview(null); setError(""); setConsent(false); setDownloadAllowed(false); setPreviewing(Boolean(id));
    if (!id) return;
    try {
      const value = await api.uploadPreview({ accountId: owner, id });
      if (expected !== previewSequence.current) return;
      setPreview(value); setTitle(value.title || ""); setSummary(value.summary || "");
    } catch (failure) {
      if (expected === previewSequence.current) setError(describeError(failure, tr));
    } finally { if (expected === previewSequence.current) setPreviewing(false); }
  }
  const submissionIdentity = preview && JSON.stringify([selected, preview.fingerprint, title.trim(), summary.trim(), downloadAllowed]);
  const retrying=retryKeys.current.has(submissionIdentity);
  const canSubmit = preview && title.trim() && summary.trim() && consent && !submitting && !blocked
    && ((!preview.duplicate&&options?.quota?.remaining!==0)||retrying);
  async function submit(event) {
    event.preventDefault();
    if (!canSubmit || pending.current) return;
    pending.current = true; setSubmitting(true); setError(""); onBusy(true);
    const key = retryKeys.current.get(submissionIdentity) || crypto.randomUUID();
    retryKeys.current.set(submissionIdentity, key);
    try {
      const result = await api.submit({ accountId: owner, id: selected, fingerprint: preview.fingerprint,
        key, title: title.trim(), summary: summary.trim(), consent: true, downloadAllowed });
      retryKeys.current.delete(submissionIdentity);
      if (mounted.current) onSubmitted(result);
    } catch (failure) {
      if (mounted.current) {
        if (/COMMUNITY_DUPLICATE_SUBMISSION\b/.test(String(failure?.message))) {
          retryKeys.current.delete(submissionIdentity);
          setPreview(current=>current&&({...current,duplicate:true}));
        }
        if (/COMMUNITY_QUOTA_EXHAUSTED\b/.test(String(failure?.message))) {
          retryKeys.current.delete(submissionIdentity);
          setAttempt(n => n+1);
        }
        setError(describeError(failure, tr));
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(false);
      onBusy(false);
    }
  }
  return <form id="community-market-upload" className="community-market-upload" onSubmit={submit}>
    <div className="community-market-upload-heading">
      <div><strong>{tr("上传插件", "Upload plugin")}</strong>
        <p className="community-market-muted">{formatMarketQuota(options?.quota, tr, language)}</p>
      </div>
      <button type="button" className="community-market-action" disabled={submitting} onClick={onClose}>{tr("取消", "Cancel")}</button>
    </div>
    {optionsError ? <div className="community-market-upload-heading">
      <p className="community-market-error" role="alert">{optionsError}</p>
      <button type="button" className="community-market-action" onClick={() => setAttempt(n => n+1)}>{tr("重试", "Retry")}</button>
    </div> : !options ? <p className="community-market-muted" role="status">{tr("正在检查本机资源和额度…", "Checking local resources and quota…")}</p>
      : !options.items.length ? <p className="community-market-muted">{tr("没有可投稿的本机资源。内置资源和从社区导入的资源不能再次投稿。", "No local resources can be submitted. Built-in resources and community imports cannot be republished.")}</p>
      : <fieldset disabled={submitting} className="community-market-upload-fields">
        <label>{tr("选择本机资源", "Choose a local resource")}
          <select value={selected} onChange={event => void choose(event.target.value)}>
            <option value="">{tr("选择 Skill、MCP、子 Agent 或皮肤", "Choose a Skill, MCP server, sub-agent or skin")}</option>
            {options.items.map(item => <option key={item.id} value={item.id}>{kindLabels[item.kind]} · {item.title}</option>)}
          </select>
        </label>
        {previewing && <p className="community-market-muted" role="status">{tr("正在准备脱敏预览…", "Preparing the sanitized preview…")}</p>}
        {preview && <>
          {preview.duplicate&&<p className="community-market-error" role="status">{tr("相同配置已经投稿或上架，不能重复上传。","This exact configuration was already submitted or listed and cannot be uploaded again.")}</p>}
          <label>{tr("公开名称", "Public title")}<input value={title} maxLength={80} required onChange={event => { setTitle(event.target.value); setConsent(false); }} /></label>
          <label>{tr("公开简介", "Public description")}<textarea value={summary} maxLength={300} rows={2} required onChange={event => { setSummary(event.target.value); setConsent(false); }} /></label>
          <details>
            <summary>{tr("查看将上传的配置", "Review the configuration to be uploaded")} · {preview.fileName}</summary>
            <p className="community-market-muted">{preview.warnings?.join(" · ")}</p>
            <pre>{preview.content}</pre>
          </details>
          <label className="community-market-check"><input type="checkbox" checked={downloadAllowed} onChange={event => { setDownloadAllowed(event.target.checked); setConsent(false); }} />{tr("发布后允许其他用户下载并添加到本机", "Allow others to download and add it locally after publication")}</label>
          <label className="community-market-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />{tr("我有权分享此配置，已检查其中没有隐私信息，并同意通过审核后公开。", "I have permission to share this configuration, have checked it for private information, and agree to public listing after approval.")}</label>
          <button type="submit" className="community-market-action community-market-add" disabled={!canSubmit}>
            <Upload size={14} aria-hidden="true" />{submitting ? tr("正在提交…", "Submitting…") : retrying&&preview.duplicate
              ? tr("核对上次投稿","Check previous submission") : tr("提交投稿", "Submit for review")}
          </button>
        </>}
      </fieldset>}
    {options?.quota?.remaining === 0 && <p className="community-market-muted">{tr("本周额度已用完，重置后可以提交新投稿。", "This week's quota is exhausted. Submit new work after it resets.")}</p>}
    {error && <p className="community-market-error" role="alert">{error}</p>}
  </form>;
}

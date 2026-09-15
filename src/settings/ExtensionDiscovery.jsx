import React, { useEffect, useRef, useState } from "react";
import { Search, X, ArrowUpRight, LoaderCircle, ShieldCheck, Download, Box, Sparkles } from "lucide-react";
import { useI18n } from "../i18n";

export function ExtensionDiscovery({ onConfigure, onInstalled }) {
  const { tr } = useI18n();
  const [kind, setKind] = useState("skill");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");
  const [verification, setVerification] = useState(null);
  const [installedName, setInstalledName] = useState("");
  const searchGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const closeRef = useRef(null);
  const previousFocus = useRef(null);
  const dialogRef = useRef(null);
  useEffect(() => () => { searchGeneration.current++; detailGeneration.current++; }, []);

  const close = () => {
    if (busy === "install" || busy === "verify") return;
    detailGeneration.current++; setDetail(null); setDetailError(""); setBusy("");
    previousFocus.current?.focus();
  };
  useEffect(() => {
    if (detail) closeRef.current?.focus();
  }, [!!detail]);

  async function search(event, more = false) {
    event?.preventDefault();
    const generation = ++searchGeneration.current;
    const requestedQuery = query.trim();
    if (requestedQuery.length < 2) return;
    setBusy("search"); setError("");
    if (!more) setResult(null);
    try {
      if (!window.desktop?.core?.searchOnlineExtensions) throw new Error(tr("请重启新版 AporiaX 后使用在线目录。", "Restart the updated desktop app to use online discovery."));
      const next = await window.desktop.core.searchOnlineExtensions({ kind, query: requestedQuery, cursor: more ? result?.nextCursor : "" });
      if (generation !== searchGeneration.current) return;
      setResult({ ...next, query: requestedQuery, kind, entries: more ? [...(result?.entries || []), ...next.entries].filter((entry, i, all) => all.findIndex((e) => JSON.stringify(e.selector) === JSON.stringify(entry.selector)) === i) : next.entries });
    } catch (e) { if (generation === searchGeneration.current) setError(e.message); }
    finally { if (generation === searchGeneration.current) setBusy(""); }
  }

  async function inspect(entry) {
    const generation = ++detailGeneration.current;
    if (!detail) previousFocus.current = document.activeElement;
    setDetail({ title: entry.title || entry.label, loading: true }); setDetailError(""); setVerification(null); setInstalledName("");
    try {
      const next = await window.desktop.core.onlineExtensionDetails(entry.selector);
      if (generation === detailGeneration.current) setDetail(next);
    } catch (e) { if (generation === detailGeneration.current) { setDetail({ title: entry.title || entry.label, failed: true, selector: entry.selector }); setDetailError(e.message); } }
  }

  async function install() {
    setBusy("install"); setDetailError("");
    try {
      const result = await window.desktop.core.installOnlineSkill({ ticket: detail.ticket });
      setInstalledName(result.skill.name); setVerification(result.verification);
      // Keep this component mounted so the verified result is not lost in a parent reload.
      await onInstalled();
    } catch (e) { setDetailError(e.message); }
    finally { setBusy(""); }
  }

  async function verify() {
    setBusy("verify"); setDetailError(""); setVerification(null);
    try { setVerification(await window.desktop.core.verifyLibrarySkill({ name: installedName })); }
    catch (e) { setDetailError(e.message); }
    finally { setBusy(""); }
  }

  function dialogKeyDown(event) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== "Tab") return;
    const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), summary, [tabindex="0"]')].filter((el) => el.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  return <section className="extension-online">
    <div className="extension-online-heading"><div><strong>{tr("在线发现", "Discover online")}</strong><p>{tr("搜索 → 审阅来源 → 安装或连接 → 验证", "Search → Review source → Install or connect → Verify")}</p></div><ShieldCheck size={19} /></div>
    <form className="extension-online-search" onSubmit={search}>
      <div className="extension-kind-switch" aria-label={tr("搜索类型", "Search type")}>
        {[["skill", "Skills"], ["mcp", "MCP"]].map(([id, title]) => <button type="button" key={id} aria-pressed={kind === id} onClick={() => { searchGeneration.current++; setKind(id); setResult(null); setError(""); setBusy(""); }}>{title}</button>)}
      </div>
      <label className="extensions-search"><Search size={15} /><input aria-label={tr("在线搜索关键字", "Online search query")} value={query} maxLength={180} onChange={(event) => { searchGeneration.current++; setQuery(event.target.value); setResult(null); setBusy(""); setError(""); }} placeholder={kind === "skill" ? tr("用途、名称或 GitHub 文件夹地址", "Use case, name, or GitHub folder URL") : tr("MCP 服务名称，例如 playwright", "MCP server name, e.g. playwright")} /></label>
      <button className="extension-primary-action" type="submit" disabled={query.trim().length < 2 || busy === "search"}>{busy === "search" ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}{tr("搜索", "Search")}</button>
    </form>
    <small className="extension-online-hint">{tr("提交的关键字会发送至 skills.sh / MCP Registry；不会上传工作区内容。目录收录不代表安全认证。", "Search terms are sent to skills.sh / MCP Registry, never workspace content. Listing does not imply security approval.")}</small>
    {error && <p role="alert" className="extensions-error">{error}</p>}
    {result && <div className="extension-online-results" aria-live="polite">
      <small>{result.source} · {result.entries.length} {tr("项", "results")}{result.cached ? tr(" · 一小时内缓存", " · Cached within one hour") : ""}</small>
      {!result.entries.length && <p>{tr("没有找到匹配项。试试英文名称，或改用 GitHub 地址 / 本地导入。", "No matches. Try another name, a GitHub URL, or a local import.")}</p>}
      {result.entries.map((entry) => <button className="extension-online-result" type="button" key={JSON.stringify(entry.selector)} onClick={() => void inspect(entry)}>
        {kind === "skill" ? <Sparkles size={17} /> : <Box size={17} />}<span><strong>{entry.title}</strong><small>{entry.source}{entry.version ? ` · ${entry.version}` : ""}</small>{entry.description && <p>{entry.description}</p>}</span><span>{tr("查看详情", "Details")}<ArrowUpRight size={14} /></span>
      </button>)}
      {result.nextCursor && <button type="button" className="extension-primary-action" disabled={busy === "search"} onClick={() => void search(null, true)}>{tr("加载更多", "Load more")}</button>}
    </div>}
    {detail && <div className="extensions-form-backdrop extension-detail-backdrop" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="extension-detail" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="extension-detail-title" onKeyDown={dialogKeyDown}>
        <header><div><small>{detail.kind === "mcp" ? "MCP" : "Skill"} · {tr("安装前审阅", "Review before installing")}</small><h4 id="extension-detail-title">{detail.title}</h4></div><button type="button" ref={closeRef} aria-label={tr("关闭扩展详情", "Close extension details")} disabled={["install", "verify"].includes(busy)} onClick={close}><X size={18} /></button></header>
        <div className="extension-detail-body">
          {detail.loading && <p role="status"><LoaderCircle className="spin" size={16} /> {tr("正在读取固定版本、许可与依赖…", "Reading version, license, and dependencies…")}</p>}
          {detailError && <p role="alert" className="extensions-error">{detailError}</p>}
          {detail.failed && <button type="button" onClick={() => void inspect(detail)}>{tr("重试", "Retry")}</button>}
          {detail.chooseDirectory ? <><p>{tr("这个仓库有多个 Skill，请选择具体文件夹：", "Choose a Skill folder from this repository:")}</p>{detail.choices.map((choice) => <button type="button" className="extension-directory-choice" key={choice.label} onClick={() => void inspect(choice)}>{choice.label}</button>)}</> : !detail.loading && !detail.failed && <>
            <p>{detail.description}</p>
            <dl><dt>{tr("来源", "Source")}</dt><dd><a href={detail.sourceUrl} target="_blank" rel="noreferrer">{detail.sourceUrl}<ArrowUpRight size={12} /></a></dd>
              <dt>{tr("许可", "License")}</dt><dd>{detail.license}</dd><dt>{tr("固定版本", "Pinned version")}</dt><dd><code>{detail.version}</code></dd>
              <dt>{tr("依赖", "Dependencies")}</dt><dd>{detail.requirements.map((r, i) => <div key={i}>{r}</div>)}</dd></dl>
            <p className="extension-detail-warning">{detail.warning}</p>
            {!!detail.compatibilityWarnings?.length && <p>{detail.compatibilityWarnings.join(" · ")}</p>}
            {detail.licenseText && <details><summary>{tr("许可原文", "License text")}</summary><pre>{detail.licenseText}</pre></details>}
            {detail.dependencies?.map((d) => <details key={d.path}><summary>{d.path}</summary><pre>{d.text}</pre></details>)}
            <details><summary>{detail.kind === "skill" ? "SKILL.md" : tr("服务配置原文", "Server manifest")}</summary><pre>{detail.manifest}</pre></details>
            {detail.files && <details><summary>{tr("包内文件", "Package files")} · {detail.fileCount}</summary><pre>{detail.files.join("\n")}</pre></details>}
            {detail.kind === "mcp" && <div className="extension-detail-choices"><h5>{tr("选择连接方式", "Choose a connection")}</h5>{!detail.choices.length && <p>{tr("目录未提供可用连接方式，请查看来源文档。", "No supported connection was provided. See source documentation.")}</p>}{detail.choices.map((choice, i) => <article key={i}><strong>{choice.label}</strong>{choice.requirements.map((r, j) => <small key={j}>{r}</small>)}{choice.reason ? <p>{choice.reason}</p> : <><pre>{JSON.stringify(choice.template, null, 2)}</pre><button className="extension-primary-action" type="button" onClick={() => { onConfigure({ template: choice.template, displayTitle: detail.title }); close(); }}>{tr("填写配置并连接", "Configure connection")}</button></>}</article>)}</div>}
            {verification && <div className="extension-verification" role="status"><ShieldCheck size={17} /><div><strong>{tr("结构与文件完整性验证通过", "Structure and file integrity verified")}</strong><p>{verification.fileCount} {tr("个文件", "files")} · {new Date(verification.checkedAt).toLocaleString()}</p><small>{tr("未执行脚本，未验证外部依赖或实际输出质量。", "Scripts, external dependencies, and output quality have not been tested.")}</small></div></div>}
          </>}
        </div>
        {detail.kind === "skill" && detail.ticket && <footer><small>{installedName ? tr("已安装到用户目录，后续任务可使用", "Installed for future tasks") : tr("只复制文件，不自动安装或执行依赖", "Copies files without installing or executing dependencies")}</small><button className="extension-primary-action" type="button" disabled={!!busy} onClick={() => void (installedName ? verify() : install())}>{busy ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}{installedName ? tr("重新验证", "Verify again") : tr("安装并校验", "Install and validate")}</button></footer>}
      </div>
    </div>}
  </section>;
}

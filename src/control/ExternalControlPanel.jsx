import React, { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Check, Copy, FolderOpen, Link2, LoaderCircle, Pause, Play, Plus, RefreshCw, ShieldCheck, Square, Trash2, X } from "lucide-react";
import { IconButton, Switch } from "../components/Controls.jsx";
import { useI18n } from "../i18n";
import { controlError, controlRequest, endpointUrl, readableValue, runIsFinished, runStateLabel } from "./control-api.js";
import "./external-control.css";

const DEFAULT_LIMITS = { maxDurationSeconds: 1800, maxModelCalls: 80, maxToolCalls: 400, maxParallelAgents: 2, maxSubagents: 12 };

function CopyButton({ value, label, onError }) {
  const { tr } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); } }, [copied]);
  return <button type="button" className="control-button" disabled={!value} onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); }
    catch { onError?.(tr("复制失败。可以选中文本手动复制。", "Copy failed. Select the text to copy it manually.")); }
  }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? tr("已复制", "Copied") : label}</button>;
}

function IssuedConnection({ issued, onHide, onError }) {
  const { tr } = useI18n();
  const [format, setFormat] = useState("mcp");
  const config = issued.connectionConfig || {};
  const text = format === "codex" ? config.codexToml : format === "api" ? config.apiExample : config.mcpJson;
  return <section className="control-issued" aria-label={tr("连接凭据", "Connection credentials")}>
    <div className="control-section-heading"><div><h3><Check size={17} />{tr("连接已创建", "Connection created")}</h3><p>{tr("把配置粘贴到其他 Harness 的 MCP 设置，保持 AporiaX 运行即可。", "Paste the configuration into your Harness’s MCP settings and keep AporiaX running.")}</p></div></div>
    <p>{tr("密钥仅在这里显示一次。复制配置后，可以隐藏凭据；需要重新配对时请撤销旧连接并创建新连接。", "The key is shown here once. Hide the credentials after copying. To pair again, revoke this connection and create a new one.")}</p>
    <div className="control-segmented" role="group" aria-label={tr("连接配置格式", "Connection configuration format")}>
      {[["mcp", "MCP JSON"], ["codex", "Codex TOML"], ["api", "HTTP API"]].map(([id, label]) => <button type="button" key={id} aria-pressed={format === id} onClick={() => setFormat(id)}>{label}</button>)}
    </div>
    {text ? <><pre className="control-code" tabIndex={0}>{text}</pre><CopyButton value={text} label={tr("复制配置", "Copy configuration")} onError={onError} /></> : <p role="status">{tr("连接配置暂不可用。请使用下方本地 API 地址和密钥，或重新创建连接。", "Configuration is unavailable. Use the local API URL and key below, or create a new connection.")}</p>}
    <details className="control-secret"><summary>{tr("查看本地 API 地址和密钥", "Show local API URL and key")}</summary>
      <label>{tr("API 地址", "API URL")}<input readOnly value={config.apiBaseUrl || ""} aria-label={tr("API 地址", "API URL")} /></label>
      <label>{tr("API 密钥", "API key")}<input readOnly value={issued.token || ""} aria-label={tr("API 密钥", "API key")} spellCheck={false} autoComplete="off" /></label>
      <CopyButton value={issued.token} label={tr("复制 API 密钥", "Copy API key")} onError={onError} />
    </details>
    <button type="button" className="control-button control-primary" onClick={onHide}>{tr("已保存，隐藏凭据", "Saved; hide credentials")}</button>
  </section>;
}

function WorkspaceSettings({ snapshot }) {
  const { tr } = useI18n();
  return <section className="control-card"><div className="control-section-heading"><div><h3>{tr("AporiaX 工作区", "AporiaX workspaces")}</h3><p>{tr("直接使用 AporiaX 中已有的项目目录，无需重复添加。创建连接时勾选该客户端需要使用的工作区。", "Uses existing project folders in AporiaX; no separate setup. Select the workspaces each client needs when creating its connection.")}</p></div></div>
    <ul className="control-workspaces">{(snapshot.workspaces || []).map(workspace => <li key={workspace.id}><FolderOpen size={15} /><div><strong>{workspace.label}</strong><code>{workspace.path}</code></div></li>)}</ul>
    {!snapshot.workspaces?.length && <p className="control-empty">{tr("暂无可用工作区。请先在 AporiaX 中创建项目并绑定目录，再刷新此页面；已删除或不可访问的目录不会列出。", "No workspaces are available. Create a project with a folder in AporiaX, then refresh this page. Deleted or inaccessible folders are not listed.")}</p>}
  </section>;
}

function CreateConnection({ snapshot, busy, onCreate }) {
  const { tr } = useI18n();
  const [name, setName] = useState("");
  const [workspaceIds, setWorkspaceIds] = useState([]);
  const [providerIds, setProviderIds] = useState([]);
  const [profiles, setProfiles] = useState(["review"]);
  const [capabilities, setCapabilities] = useState({ commands: false, browser: false, mcp: false });
  const [mcpIds, setMcpIds] = useState("");
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(1);
  const [limits, setLimits] = useState(() => ({ ...DEFAULT_LIMITS, ...snapshot.limits }));
  const [modelIds, setModelIds] = useState([]);
  const toggle = (setter, value) => setter(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value]);
  const workspaces = snapshot.workspaces || [];
  const providers = snapshot.providers || [];
  const validWorkspaceIds = workspaceIds.filter(id => workspaces.some(workspace => workspace.id === id));
  const validProviderIds = providerIds.filter(id => providers.some(provider => provider.id === id));
  const models = providers.filter(provider => validProviderIds.includes(provider.id)).flatMap(provider => (provider.models || []).map(model => ({ ...model, providerName: provider.name })));
  const validModelIds = modelIds.filter(id => models.some(model => model.id === id));
  const allowedMcpServerIds = mcpIds.split(/[,，\n]/).map(id => id.trim()).filter(Boolean);
  const valid = name.trim() && validWorkspaceIds.length && validProviderIds.length && profiles.length && (!capabilities.mcp || allowedMcpServerIds.length);
  return <form className="control-card control-create" onSubmit={event => {
    event.preventDefault();
    if (!valid || busy) return;
    void onCreate({ name: name.trim(), workspaceIds: validWorkspaceIds, providerIds: validProviderIds, profiles, capabilities, allowedMcpServerIds: capabilities.mcp ? allowedMcpServerIds : [], modelIds: validModelIds, maxConcurrentRuns: Number(maxConcurrentRuns), limits }).then(success => { if (success) setName(""); });
  }}>
    <div className="control-section-heading"><div><h3>{tr("创建连接", "Create a connection")}</h3><p>{tr("为每个 Harness 创建独立连接，可随时撤销。", "Create a separate connection for each Harness. Revoke it at any time.")}</p></div></div>
    <fieldset disabled={busy}><label className="control-field">{tr("连接名称", "Connection name")}<input value={name} maxLength={80} required placeholder="Codex / Claude Code / My Harness" onChange={event => setName(event.target.value)} /></label>
      <fieldset className="control-choice-group"><legend>{tr("工作区", "Workspaces")}</legend>{workspaces.map(workspace => <label key={workspace.id}><input type="checkbox" checked={validWorkspaceIds.includes(workspace.id)} onChange={() => toggle(setWorkspaceIds, workspace.id)} /><span>{workspace.label}<small>{workspace.path}</small></span></label>)}{!workspaces.length && <p className="control-muted">{tr("请先在 AporiaX 中创建并绑定工作区。", "Create and bind a workspace in AporiaX first.")}</p>}</fieldset>
      <fieldset className="control-choice-group"><legend>{tr("代理预设", "Agent profiles")}</legend><label><input type="checkbox" checked={profiles.includes("review")} onChange={() => toggle(setProfiles, "review")} /><span>{tr("审查", "Review")}<small>{tr("读取、分析和审查项目。", "Read, analyze, and review a project.")}</small></span></label><label><input type="checkbox" checked={profiles.includes("workspace")} onChange={() => toggle(setProfiles, "workspace")} /><span>{tr("工作区编辑", "Workspace editing")}<small>{tr("在独立工作区副本中编辑，交付补丁与产物；源目录不会自动回写。", "Edit in an isolated workspace copy and return patches and artifacts; the source directory is not updated automatically.")}</small></span></label></fieldset>
      <fieldset className="control-choice-group"><legend>{tr("允许使用的模型服务", "Allowed model providers")}</legend>{providers.map(provider => <label key={provider.id}><input type="checkbox" checked={validProviderIds.includes(provider.id)} onChange={() => toggle(setProviderIds, provider.id)} /><span>{provider.name || provider.id}</span></label>)}{!providers.length && <p className="control-muted">{tr("请先在 AporiaX 设置中连接模型服务。", "Connect a model provider in AporiaX settings first.")}</p>}</fieldset>
      <details className="control-advanced"><summary>{tr("能力与运行限额", "Capabilities and run limits")}</summary>
        <fieldset className="control-choice-group"><legend>{tr("额外能力", "Additional capabilities")}</legend>{[["commands", tr("运行命令", "Run commands")], ["browser", tr("操作浏览器", "Operate the browser")], ["mcp", tr("调用指定 MCP 服务", "Call specific MCP servers")]].map(([id, label]) => <label key={id}><input type="checkbox" checked={capabilities[id]} onChange={event => setCapabilities(current => ({ ...current, [id]: event.target.checked }))} /><span>{label}</span></label>)}</fieldset>
        {capabilities.mcp && <label className="control-field">{tr("允许的 MCP 服务 ID（逗号分隔）", "Allowed MCP server IDs (comma separated)")}<input value={mcpIds} onChange={event => setMcpIds(event.target.value)} required /></label>}
        {!!models.length && <fieldset className="control-choice-group"><legend>{tr("指定模型（不选则允许所选服务中的全部模型）", "Specific models (leave empty to allow all models from selected providers)")}</legend>{models.map((model, index) => <label key={`${model.providerName}:${model.id}:${index}`}><input type="checkbox" checked={validModelIds.includes(model.id)} onChange={() => toggle(setModelIds, model.id)} /><span>{model.name || model.id}<small>{model.providerName} · {model.id}</small></span></label>)}</fieldset>}
        <div className="control-limits"><label className="control-field">{tr("同时运行任务数", "Concurrent runs")}<input type="number" min="1" max="4" required value={maxConcurrentRuns} onChange={event => setMaxConcurrentRuns(event.target.value)} /></label>{[["maxDurationSeconds", tr("单任务时限（秒）", "Run duration (seconds)"), 1, 86400], ["maxModelCalls", tr("模型调用次数", "Model calls"), 0, 2000], ["maxToolCalls", tr("工具调用次数", "Tool calls"), 0, 10000], ["maxParallelAgents", tr("并行代理数", "Parallel agents"), 0, 8], ["maxSubagents", tr("子代理总数", "Total subagents"), 0, 100]].map(([id, label, min, max]) => <label key={id} className="control-field">{label}<input type="number" min={min} max={max} required value={limits[id]} onChange={event => setLimits(current => ({ ...current, [id]: event.target.value === "" ? "" : Number(event.target.value) }))} /></label>)}</div>
        <p className="control-muted">{tr("任务使用 AporiaX 配置的模型及其额度。这里的限额控制运行量，不是费用报价。", "Tasks use the models and quota configured in AporiaX. These limits cap execution; they are not a cost estimate.")}</p>
      </details>
      <button type="submit" className="control-button control-primary" disabled={!valid || busy || !snapshot.enabled}><Plus size={15} />{tr("创建并获取连接配置", "Create and get connection settings")}</button>{!snapshot.enabled && <p className="control-muted">{tr("请先打开上方的外部连接开关。", "Enable external connections above first.")}</p>}
    </fieldset>
  </form>;
}

function ClientList({ snapshot, busy, mutate, onRevoke }) {
  const { tr } = useI18n();
  return <section className="control-card"><div className="control-section-heading"><div><h3>{tr("已配对的客户端", "Paired clients")}</h3><p>{tr("撤销会停止这个客户端的进行中任务，并拒绝它后续的请求。已保存的结果仍然保留。", "Revoking stops this client’s active runs and denies future requests. Saved results are retained.")}</p></div></div>
    {!snapshot.clients?.length ? <p className="control-empty">{tr("尚未创建连接。", "No connections yet.")}</p> : <ul className="control-clients">{snapshot.clients.map(client => <li key={client.id}><div><strong>{client.name}</strong><span className={`control-badge ${client.revokedAt ? "muted" : "ready"}`}>{client.revokedAt ? tr("已撤销", "Revoked") : tr("已授权", "Authorized")}</span><p>{(client.workspaceIds || []).map(id => snapshot.workspaces?.find(workspace => workspace.id === id)?.label || id).join(" · ")}</p><small>{(client.profiles || []).join(" / ")} · {tr("最多 {count} 个并行任务", "Up to {count} concurrent run(s)", { count: client.maxConcurrentRuns || 1 })}</small></div><button type="button" className="control-button control-danger" disabled={busy || Boolean(client.revokedAt)} onClick={() => mutate(async () => { await controlRequest("revokeClient", { clientId: client.id }); onRevoke(client.id); })}><Trash2 size={14} />{tr("撤销连接", "Revoke connection")}</button></li>)}</ul>}
  </section>;
}

function QuestionForm({ question, busy, onAnswer }) {
  const { tr } = useI18n();
  const [text, setText] = useState("");
  const [optionId, setOptionId] = useState("");
  const pending = question.status === "pending" && !question.answer;
  return <section className="control-question"><h4>{question.question}</h4>{question.reason && <p>{question.reason}</p>}{pending ? <form onSubmit={event => { event.preventDefault(); if (optionId || text.trim()) onAnswer(question.id, optionId ? { optionId } : { text: text.trim() }); }}><fieldset disabled={busy} className="control-choice-group">{(question.options || []).map(option => <label key={option.id}><input type="radio" name={`control-question-${question.id}`} checked={optionId === option.id} onChange={() => { setOptionId(option.id); setText(""); }} /><span>{option.label}<small>{option.description}</small></span></label>)}<label className="control-field">{tr("你的回答", "Your answer")}<textarea maxLength={4000} rows={3} value={text} onChange={event => { setText(event.target.value); setOptionId(""); }} /></label></fieldset><p className="control-muted">{tr("回答会继续任务；执行审批在下方单独处理。", "Your answer continues the task. Execution approvals are handled separately below.")}</p><button type="submit" className="control-button control-primary" disabled={busy || (!optionId && !text.trim())}>{tr("回答并继续", "Answer and continue")}</button></form> : <p>{readableValue(question.answer?.text || question.answer) || tr("问题已关闭", "Question closed")}</p>}</section>;
}

function RunDetail({ runId, snapshot, signal }) {
  const { tr } = useI18n();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [sectionErrors, setSectionErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const eventsRef = useRef({ events: [], nextSeq: 0, hasMore: false });
  const mounted = useRef(true);
  const loading = useRef(false);
  const acting = useRef(false);
  const refresh = useCallback(async () => {
    if (loading.current || !mounted.current) return;
    loading.current = true;
    const names = ["getRun", "getResult", "getAgents", "getQuestions", "getApprovals", "getEvents"];
    const responses = await Promise.allSettled(names.map(action => controlRequest(action, { runId, ...(action === "getEvents" ? { afterSeq: eventsRef.current.nextSeq, limit: 100 } : {}) })));
    loading.current = false;
    if (!mounted.current) return;
    const values = {};
    const failed = [];
    responses.forEach((response, index) => { if (response.status === "fulfilled") values[names[index]] = response.value; else failed.push(controlError(response.reason, tr)); });
    if (values.getEvents) {
      const merged = new Map(eventsRef.current.events.map(event => [event.seq, event]));
      for (const event of values.getEvents.events || []) merged.set(event.seq, event);
      eventsRef.current = { ...values.getEvents, events: [...merged.values()].sort((a, b) => a.seq - b.seq).slice(-1000) };
    }
    setDetail(current => ({ ...current, ...(values.getRun ? { run: values.getRun } : {}), ...(values.getResult ? { result: values.getResult } : {}), ...(values.getAgents ? { agents: values.getAgents.agents || [] } : {}), ...(values.getQuestions ? { questions: values.getQuestions.questions || [] } : {}), ...(values.getApprovals ? { approvals: values.getApprovals.approvals || [] } : {}), ...eventsRef.current }));
    setSectionErrors([...new Set(failed)]);
  }, [runId, tr]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [refresh]);
  useEffect(() => { void refresh(); }, [signal, refresh]);
  const act = async (action, input = {}) => {
    if (acting.current) return false;
    acting.current = true; setBusy(true); setError("");
    let success = false;
    try { await controlRequest(action, { runId, ...input }); success = true; await refresh(); }
    catch (failure) { if (mounted.current) setError(controlError(failure, tr)); }
    finally { acting.current = false; if (mounted.current) setBusy(false); }
    return success;
  };
  const run = detail?.run;
  if (!run) return <div className="control-run-detail" aria-live="polite">{sectionErrors.length ? sectionErrors.map(item => <p role="alert" className="control-error" key={item}>{item}</p>) : <p><LoaderCircle className="spin" size={16} />{tr("正在读取任务…", "Loading run…")}</p>}<button className="control-button" type="button" onClick={() => void refresh()}>{tr("重试", "Retry")}</button></div>;
  const finished = runIsFinished(run.status);
  const resumable = run.status === "paused";
  const preparing = ["queued", "starting", "cancelling"].includes(run.status);
  const result = detail.result?.result;
  const summary = typeof result === "string" ? result : result?.summary || result?.finalText || result?.content || result?.message;
  return <article className="control-run-detail" aria-label={tr("外部任务详情", "External run details")}>
    <div className="control-section-heading"><div><span className={`control-badge ${run.status === "running" ? "ready" : ""}`}>{runStateLabel(run.status, tr)}</span><h3>{run.instruction || run.runId}</h3><p>{run.clientName || run.clientId} · {snapshot.workspaces?.find(workspace => workspace.id === run.workspaceId)?.label || run.workspaceId}</p><code>{run.runId}</code></div><IconButton label={tr("刷新任务", "Refresh run")} onClick={() => void refresh()}><RefreshCw size={16} /></IconButton></div>
    {run.profile === "workspace" && <section className="control-workspace-note"><strong>{tr("独立工作区交付", "Isolated workspace delivery")}</strong><p>{tr("这项任务在独立副本中编辑。修改不会自动应用到源目录；请检查结果中的补丁、产物和验证，再合并所需修改。", "This run edits an isolated copy. Changes are not applied to the source directory automatically. Review the patch, artifacts, and verification before merging changes.")}</p>{run.executionWorkspacePath && <><code>{run.executionWorkspacePath}</code><button type="button" className="control-button" disabled={busy || !window.desktop?.openWorkspace} onClick={async () => {
      try { await window.desktop.openWorkspace(run.executionWorkspacePath); }
      catch (failure) { setError(controlError(failure, tr)); }
    }}><FolderOpen size={14} />{tr("打开执行目录", "Open execution directory")}</button></>}</section>}
    <div className="control-actions"><button type="button" className="control-button" disabled={busy || finished || resumable || preparing} onClick={() => act("pauseRun")}><Pause size={14} />{tr("暂停任务", "Pause run")}</button><button type="button" className="control-button" disabled={busy || !resumable} onClick={() => act("resumeRun")}><Play size={14} />{tr("继续任务", "Resume run")}</button><button type="button" className="control-button control-danger" disabled={busy || finished} onClick={() => act("cancelRun")}><Square size={14} />{tr("停止任务", "Stop run")}</button></div>
    {error && <p role="alert" className="control-error">{error}</p>}{sectionErrors.map(item => <p role="alert" className="control-error" key={item}>{item}</p>)}{run.error && <pre className="control-error">{readableValue(run.error)}</pre>}
    {!!detail.questions?.length && <section className="control-run-section"><h3>{tr("任务提问", "Task questions")}</h3>{detail.questions.map(question => <QuestionForm key={question.id} question={question} busy={busy} onAnswer={(questionId, answer) => act("answerQuestion", { questionId, answer })} />)}</section>}
    {!!detail.approvals?.length && <section className="control-run-section"><h3><ShieldCheck size={16} />{tr("等待本机审批", "Awaiting local approval")}</h3>{detail.approvals.map(item => { const approval = item.approval || item; return <section className="control-approval" key={item.approvalId || approval.id}><h4>{approval.title || approval.tool || approval.kind}</h4>{approval.command && <pre className="control-code">{approval.command}</pre>}{approval.cwd && <p><code>{approval.cwd}</code></p>}<details><summary>{tr("查看完整审批请求", "View full approval request")}</summary><pre className="control-code">{readableValue(approval)}</pre></details><div className="control-actions"><button type="button" disabled={busy} className="control-button" onClick={() => act("respondApproval", { approvalId: item.approvalId || approval.id, approved: false, scope: "once" })}>{tr("拒绝", "Deny")}</button><button type="button" disabled={busy} className="control-button control-primary" onClick={() => act("respondApproval", { approvalId: item.approvalId || approval.id, approved: true, scope: "once" })}>{tr("批准这一次", "Approve once")}</button></div></section>; })}</section>}
    {!finished && <form className="control-run-section" onSubmit={async event => { event.preventDefault(); if (message.trim() && await act("sendMessage", { content: message.trim() })) setMessage(""); }}><label className="control-field">{tr("追加指导", "Add guidance")}<textarea rows={3} maxLength={12000} value={message} onChange={event => setMessage(event.target.value)} placeholder={tr("补充要求或调整任务方向", "Add requirements or adjust the task direction")} /></label><button type="submit" className="control-button" disabled={busy || preparing || !message.trim()}>{tr("发送到任务", "Send to run")}</button></form>}
    <section className="control-run-section"><h3>{tr("结果与产物", "Result and artifacts")}</h3>{summary ? <pre className="control-output">{readableValue(summary)}</pre> : <p className="control-muted">{finished ? tr("任务已结束，未返回文本摘要。查看完整结果和事件。", "The run ended without a text summary. Inspect the full result and events.") : tr("任务结果将在这里保留，断开连接后也能查看。", "The result is retained here, including after the client disconnects.")}</p>}{result != null && typeof result !== "string" && <details><summary>{tr("完整结果、修改与验证", "Full result, changes, and verification")}</summary><pre className="control-code">{readableValue(result)}</pre></details>}{!!detail.result?.artifacts?.length && <ul className="control-artifacts">{detail.result.artifacts.map((artifact, index) => <li key={artifact.id || index}><strong>{artifact.name || artifact.path || artifact.id}</strong><code>{artifact.uri || artifact.path || artifact.artifactId || artifact.id}</code></li>)}</ul>}</section>
    <section className="control-run-section"><h3>{tr("代理", "Agents")}</h3>{detail.agents?.length ? <ul className="control-agents">{detail.agents.map((agent, index) => <li key={agent.id || agent.agentId || index}><strong>{agent.name || agent.role || agent.id || agent.agentId}</strong><span>{runStateLabel(agent.status, tr)}</span></li>)}</ul> : <p className="control-muted">{tr("暂无子代理记录。", "No subagent records yet.")}</p>}</section>
    <section className="control-run-section"><h3>{tr("执行事件", "Execution events")}</h3><p className="control-muted">{tr("按顺序显示最近 1,000 条已读取事件；完整记录由本地 API 提供。", "Shows the latest 1,000 loaded events in order. The local API provides the full record.")}</p>{detail.events?.length ? <ol className="control-events">{detail.events.map(event => <li key={event.seq}><details><summary><code>#{event.seq}</code><strong>{event.type}</strong><time>{event.at ? new Date(event.at).toLocaleTimeString() : ""}</time></summary><pre className="control-code">{readableValue(event.payload)}</pre></details></li>)}</ol> : <p className="control-muted">{tr("暂无事件。", "No events yet.")}</p>}{detail.hasMore && <button type="button" className="control-button" onClick={() => void refresh()}>{tr("读取更多事件", "Load more events")}</button>}</section>
  </article>;
}


export function ExternalControlPanel({ onClose, initialRunId = "" }) {
  const { tr } = useI18n();
  const [snapshot, setSnapshot] = useState(null);
  const [tab, setTab] = useState(initialRunId ? "runs" : "connections");
  const [runId, setRunId] = useState(initialRunId);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null);
  const [signal, setSignal] = useState(0);
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  const issuedRef = useRef(null);
  const mounted = useRef(true);
  const loading = useRef(false);
  const acting = useRef(false);
  closeRef.current = onClose;
  issuedRef.current = issued;
  const refresh = useCallback(async () => {
    if (loading.current || !mounted.current) return;
    loading.current = true;
    try { const value = await controlRequest("status"); if (mounted.current) { setSnapshot(value); setSignal(current => current + 1); } }
    catch (failure) { if (mounted.current) setError(controlError(failure, tr, issuedRef.current?.token)); }
    finally { loading.current = false; }
  }, [tr]);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    dialogRef.current?.focus();
    void refresh();
    let eventTimer;
    const unsubscribe = window.desktop?.control?.subscribe?.(() => { clearTimeout(eventTimer); eventTimer = setTimeout(() => void refresh(), 200); });
    const poll = setInterval(() => void refresh(), 6000);
    const keydown = event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key === "Tab") {
        const elements = [...(dialogRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex="0"]') || [])].filter(element => element.getClientRects().length);
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { mounted.current = false; issuedRef.current = null; clearTimeout(eventTimer); clearInterval(poll); if (typeof unsubscribe === "function") unsubscribe(); document.removeEventListener("keydown", keydown, true); previous?.focus?.(); };
  }, [refresh]);
  useEffect(() => { if (initialRunId) { setTab("runs"); setRunId(initialRunId); } }, [initialRunId]);
  useEffect(() => { if (!runId && snapshot?.runs?.length) setRunId(snapshot.runs[0].runId); }, [snapshot, runId]);
  const mutate = async operation => {
    if (acting.current) return false;
    acting.current = true; setBusy(true); setError("");
    try { await operation(); await refresh(); return true; }
    catch (failure) { if (mounted.current) setError(controlError(failure, tr, issuedRef.current?.token)); return false; }
    finally { acting.current = false; if (mounted.current) setBusy(false); }
  };
  const create = input => mutate(async () => { const value = await controlRequest("createClient", input); if (mounted.current) { setIssued(value); setTimeout(() => dialogRef.current?.querySelector(".control-issued")?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0); } });
  const runs = snapshot?.runs || [];
  return <div className="control-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="external-control-panel" role="dialog" aria-modal="true" aria-labelledby="external-control-title" tabIndex={-1}>
      <header className="control-header"><div className="control-title-icon"><Link2 size={23} /></div><div><h2 id="external-control-title">{tr("外部连接", "External connections")}</h2><p>{tr("让其他 Harness 使用 AporiaX 的代理与本地工作区。", "Let other Harnesses use AporiaX agents and local workspaces.")}</p></div><IconButton label={tr("关闭外部连接", "Close external connections")} onClick={onClose}><X size={19} /></IconButton></header>
      <nav className="control-tabs" aria-label={tr("外部连接页面", "External connection pages")}><button type="button" aria-current={tab === "connections" ? "page" : undefined} onClick={() => setTab("connections")}><Link2 size={15} />{tr("连接管理", "Connections")}</button><button type="button" aria-current={tab === "runs" ? "page" : undefined} onClick={() => setTab("runs")}><Activity size={15} />{tr("外部任务", "External tasks")}<span>{runs.length}</span></button><IconButton label={tr("刷新外部连接", "Refresh external connections")} onClick={() => { setError(""); void refresh(); }}><RefreshCw size={15} /></IconButton></nav>
      {error && <p role="alert" className="control-error control-global-error">{error}</p>}
      {!snapshot ? <div className="control-loading">{error ? <button type="button" className="control-button" onClick={() => { setError(""); void refresh(); }}>{tr("重试连接", "Retry connection")}</button> : <><LoaderCircle className="spin" size={21} /><p>{tr("正在连接本地服务…", "Connecting to the local service…")}</p></>}</div> : tab === "connections" ? <div className="control-scroll">
        <section className="control-enable"><div><h3><span className={`control-status-dot ${snapshot.enabled ? "enabled" : ""}`} />{snapshot.enabled ? tr("本地连接已开启", "Local connections enabled") : tr("本地连接已关闭", "Local connections disabled")}</h3><p>{tr("连接仅在这台电脑可用。关闭会停止进行中的外部任务并拒绝外部请求，已保存的结果仍然保留。", "Connections are available on this computer. Disabling stops active external runs and rejects requests. Saved results are retained.")}</p>{snapshot.enabled && endpointUrl(snapshot.endpoint) && <code>{endpointUrl(snapshot.endpoint)}</code>}</div><Switch checked={Boolean(snapshot.enabled)} disabled={busy} label={tr("启用外部连接", "Enable external connections")} onChange={enabled => mutate(() => controlRequest("setEnabled", { enabled }))} /></section>
        {issued && <IssuedConnection key={issued.client?.id} issued={issued} onHide={() => setIssued(null)} onError={setError} />}
        <div className="control-setup-grid"><WorkspaceSettings snapshot={snapshot} /><CreateConnection snapshot={snapshot} busy={busy} onCreate={create} /></div>
        <ClientList snapshot={snapshot} busy={busy} mutate={mutate} onRevoke={clientId => { if (issued?.client?.id === clientId) setIssued(null); }} />
      </div> : <div className="control-runs"><aside className="control-run-list" aria-label={tr("外部任务列表", "External run list")}>{runs.length ? runs.map(run => <button type="button" key={run.runId} aria-pressed={runId === run.runId} onClick={() => setRunId(run.runId)}><span className={`control-badge ${run.status === "running" ? "ready" : ""}`}>{runStateLabel(run.status, tr)}</span><strong>{run.instruction || run.runId}</strong><small>{run.clientName || run.clientId}</small><small>{snapshot.workspaces?.find(workspace => workspace.id === run.workspaceId)?.label || run.workspaceId}</small></button>) : <p className="control-empty">{tr("其他 Harness 创建的任务会显示在这里。", "Runs created by other Harnesses will appear here.")}</p>}</aside>{runId ? <RunDetail key={runId} runId={runId} snapshot={snapshot} signal={signal} /> : <div className="control-no-run"><Activity size={30} /><h3>{tr("从其他 Harness 委托第一个任务", "Delegate your first task from another Harness")}</h3><p>{tr("完成连接配置后，让它检查工作区或执行一个任务。进度、提问、审批和最终成果都会在这里保留。", "After connecting, ask it to inspect a workspace or carry out a task. Progress, questions, approvals, and final results are retained here.")}</p></div>}</div>}
    </section>
  </div>;
}

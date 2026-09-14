import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/common";
import { ArrowUp, ArrowUpRight, Check, ChevronDown, Copy, Info, MessagesSquare, Square, Trash2 } from "lucide-react";
import { messageLinkUrl } from "../../electron/link-target.js";
import { taskSnapshot } from "../../electron/side-chat/context.js";
import { useI18n } from "../i18n";
import { getAvailableModels } from "../models/model-catalog.js";
import { SideChatModelPicker, sideChatModelLabel } from "./SideChatModelPicker.jsx";
import { SideChatDialog } from "./SideChatDialog.jsx";
import "./side-chat.css";

const states = { running: "运行中", paused: "已暂停", completed: "已完成", failed: "发生错误", stopped: "已停止", interrupted: "已中断", idle: "未运行", waiting: "等待中", thinking: "等待模型" };
const activities = { "response.activity": "收到模型流式数据", "response.delta": "模型正在输出", "response.retry": "模型请求重试", "tool.started": "正在执行工具", "tool.completed": "工具执行结束", "subagent.started": "子 Agent 开始工作", "turn.completed": "本轮结束" };
const merge = (messages, incoming) => messages.some((m) => m.id === incoming.id)
  ? messages.map((m) => m.id === incoming.id ? incoming : m) : [...messages, incoming];
const clock = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString() : "未报告";

function Code({ className = "", children }) {
  const value = String(children || "");
  const language = className.replace("language-", "");
  if (!className || !hljs.getLanguage(language)) return <code className={className}>{children}</code>;
  return <code className={className} dangerouslySetInnerHTML={{ __html: hljs.highlight(value, { language }).value }} />;
}

function SideChatMarkdown({ content, sources, onOpenLink }) {
  const latest = useRef({ sources, onOpenLink });
  latest.current = { sources, onOpenLink };
  // Stable renderer component types preserve the clicked link while state and
  // live task updates render, so closing a dialog can return keyboard focus.
  const components = useMemo(() => ({
    code: Code,
    a: ({ href, children }) => <a href={href} onClick={(event) => latest.current.onOpenLink(event, href, latest.current.sources)}>{children}</a>,
    img: ({ alt }) => <span>{alt}</span>,
  }), []);
  return <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url) => url.startsWith("#record-") ? url : messageLinkUrl(url)} components={components}>{content}</ReactMarkdown>;
}

export function SideChatPane({ task, workbench, providers = [], isRunning = false, isPaused = false, onSendToMain }) {
  const { tr } = useI18n();
  const [mode, setMode] = useState(() => workbench.draft("sidechat:mode") === "general" ? "general" : "task");
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [activity, setActivity] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [dialogError, setDialogError] = useState("");
  const [transfer, setTransfer] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [copied, setCopied] = useState("");
  const [retryLoad, setRetryLoad] = useState(0);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const followRef = useRef(true);
  const taskRef = useRef(task);
  taskRef.current = task;
  const scope = workbench.key;
  const viewKey = scope + ":" + mode;
  const viewRef = useRef(viewKey);
  viewRef.current = viewKey;
  const mainRunId = task.messages?.findLast((m) => m.role === "assistant")?.runId;
  const options = useMemo(() => getAvailableModels(providers).map((model) => ({ ...model, modelId: model.id, value: JSON.stringify([model.providerId, model.id]) })), [providers]);
  const [selected, setSelected] = useState(() => {
    try { return localStorage.getItem(scope + ":sidechat-model") || ""; } catch { return ""; }
  });
  const choice = options.find((o) => o.value === selected)
    || options.find((o) => o.providerId === task.providerId && o.modelId === task.modelId) || options[0];
  const request = (action, extra = {}) => {
    if (!window.desktop?.sideChat) return Promise.reject(new Error("请重启最新版 AporiaX 桌面端以使用侧边聊天。"));
    return window.desktop.sideChat.request({ action, taskId: task.id, scope, mode, ...extra });
  };
  const running = messages.findLast((m) => m.status === "running");
  const busy = Boolean(pending || running);
  const snapshot = useMemo(() => taskSnapshot(task, { isRunning, isPaused, ...(activity || {}) }), [task, isRunning, isPaused, activity]);

  useEffect(() => {
    setActivity(null);
    let timer, next;
    const unsubscribe = window.desktop?.harness?.onEvent?.((event) => {
      const current = taskRef.current;
      const latest = current.messages?.findLast((m) => m.role === "assistant");
      if (event.taskId ? event.taskId !== current.id : !latest?.runId || event.runId !== latest.runId) return;
      if (latest?.runId && event.runId && event.runId !== latest.runId) return;
      if (!activities[event.type]) return;
      next = { activity: event.type, lastActivityAt: event.timestamp || new Date().toISOString(), runId: event.runId };
      // Main token streaming must not trigger a second unbounded render stream.
      if (!timer) timer = setTimeout(() => { timer = null; setActivity(next); }, 250);
    });
    return () => { clearTimeout(timer); unsubscribe?.(); };
  }, [scope, mainRunId]);

  useEffect(() => {
    let disposed = false;
    let updates = 0;
    setLoading(true); setError(""); setMessages([]); setDialog(null); setDialogError(""); setTransfer(""); setPending("");
    const cachedDraft = workbench.draft("sidechat:" + mode);
    setDraft(typeof cachedDraft === "string" ? cachedDraft : "");
    const unsubscribe = window.desktop?.sideChat?.subscribe((event) => {
      if (disposed || event.scope !== scope || event.taskId !== task.id || event.mode !== mode) return;
      if (event.type === "message") {
        updates++;
        setMessages((current) => merge(current, event.message));
        if (event.message.status !== "running") setPending((id) => id === event.requestId ? "" : id);
      } else if (event.type === "response.retry") {
        setError(tr("侧聊模型正在重试，不影响主任务。", "Side chat is retrying; the main task is unaffected."));
      }
    });
    request("load").then((session) => {
      if (disposed) return;
      setMessages((current) => updates ? session.messages.reduce((all, m) => all.some((x) => x.id === m.id) ? all : [...all, m], current).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.role === "user" ? -1 : 1)) : session.messages);
    }).catch((failure) => { if (!disposed) setError(failure.message); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; unsubscribe?.(); };
  }, [viewKey, retryLoad]);

  useEffect(() => {
    if (followRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, pending]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = Math.min(156, Math.max(58, input.scrollHeight)) + "px";
  }, [draft]);

  const updateDraft = (value) => { setDraft(value); workbench.saveDraft("sidechat:" + mode, value); };
  const send = async () => {
    if (!draft.trim() || busy || loading || !choice) return;
    const key = viewKey, content = draft.trim(), requestId = crypto.randomUUID();
    setPending(requestId); setError(""); followRef.current = true;
    setMessages((current) => [...current, { id: "user-" + requestId, role: "user", content, createdAt: new Date().toISOString() }]);
    updateDraft("");
    try {
      const session = await request("send", { requestId, message: content, providerId: choice.providerId, modelId: choice.modelId, ...(mode === "task" ? { snapshot } : {}) });
      if (viewRef.current === key) setMessages(session.messages);
    } catch (failure) {
      if (viewRef.current === key) {
        setError(failure.message);
        setMessages((current) => current.filter((m) => m.id !== "user-" + requestId));
        updateDraft(content);
      }
    } finally { if (viewRef.current === key) setPending(""); }
  };
  const cancel = () => request("cancel", { requestId: pending || running?.requestId }).catch((failure) => setError(failure.message));
  const showDialog = (value) => { setDialogError(""); setDialog(value); };
  const closeDialog = () => { setDialog(null); setDialogError(""); };
  const showSource = (record, sources) => showDialog({ kind: "source", record, sources });
  const openTarget = async (open) => {
    const currentDialog = dialogRef.current, key = viewKey;
    try {
      const opened = await open();
      if (opened === false) throw new Error(tr("无法打开此链接。", "Cannot open this link."));
      if (viewRef.current === key && dialogRef.current === currentDialog) closeDialog();
    } catch (failure) {
      if (viewRef.current !== key) return;
      if (currentDialog && dialogRef.current === currentDialog) setDialogError(failure.message);
      else setError(failure.message);
    }
  };
  const openLink = (event, href, sources) => {
    event.preventDefault();
    if (href?.startsWith("#record-")) {
      const record = sources?.find((r) => r.id === href.slice(8));
      if (record) showSource(record, sources); else (dialogRef.current ? setDialogError : setError)(tr("该引用记录不可用。", "This reference is unavailable."));
      return;
    }
    void openTarget(() => workbench.openHref(href));
  };
  const markdown = (content, sources) => <SideChatMarkdown content={content} sources={sources} onOpenLink={openLink} />;
  const clearHistory = async () => {
    const key = viewKey, currentDialog = dialog;
    setLoading(true); setDialogError("");
    try {
      const session = await request("clear");
      if (viewRef.current !== key) return;
      setMessages(session.messages);
      if (dialogRef.current === currentDialog) closeDialog();
    } catch (failure) {
      if (viewRef.current === key) (dialogRef.current === currentDialog ? setDialogError : setError)(failure.message);
    } finally { if (viewRef.current === key) setLoading(false); }
  };
  const sendToMain = async () => {
    const key = viewKey, currentDialog = dialog;
    setTransferring(true); setDialogError("");
    try {
      const accepted = await onSendToMain(transfer.trim());
      if (accepted === false) throw new Error("主任务未接收指令，请检查模型配置。");
      if (viewRef.current === key && dialogRef.current === currentDialog) closeDialog();
    } catch (failure) {
      if (viewRef.current === key) (dialogRef.current === currentDialog ? setDialogError : setError)(failure.message);
    } finally { setTransferring(false); }
  };
  const copy = async (message) => {
    try { await navigator.clipboard.writeText(message.content); setCopied(message.id); }
    catch (failure) { setError(failure.message); }
  };
  return <section className="side-chat" aria-label={tr("侧边聊天", "Side chat")}>
    <header className="side-chat-heading">
      <div className="side-chat-modes" role="group" aria-label={tr("侧聊模式", "Side chat mode")}>
        {[{ id: "task", label: tr("当前任务", "Task"), title: tr("关联当前任务", "Current task"), hint: tr("读取当前任务公开记录，不打断主任务", "Read public task records without interrupting it") }, { id: "general", label: tr("普通聊天", "Chat"), title: tr("普通聊天", "General chat"), hint: tr("独立历史，不读取任务或 Understanding", "Separate history, no task or Understanding context") }].map((item) => <button key={item.id} type="button" aria-label={item.title} title={item.hint} aria-pressed={mode === item.id} disabled={busy || loading} onClick={() => { setMode(item.id); closeDialog(); workbench.saveDraft("sidechat:mode", item.id); }}>{item.label}</button>)}
      </div>
      <div className="side-chat-heading-actions">
        {mode === "task" && <button type="button" className="side-chat-status-trigger" aria-label={tr("查看任务状态", "View task status")} aria-haspopup="dialog" aria-expanded={dialog?.kind === "status"} title={(task.title || tr("当前任务", "Current task")) + " · " + (states[snapshot.status] || snapshot.status)} onClick={() => showDialog({ kind: "status" })}><span className={"side-chat-status-dot " + (isRunning ? "live" : snapshot.status)} /><span>{states[snapshot.status] || snapshot.status}</span><ChevronDown size={12} /></button>}
        <button type="button" className="side-chat-icon" aria-label={tr("清空侧聊历史", "Clear side chat history")} title={tr("清空当前模式的侧聊历史", "Clear this mode's side-chat history")} disabled={busy || loading || !messages.length} onClick={() => showDialog({ kind: "clear" })}><Trash2 size={14} /></button>
      </div>
    </header>
    <div className="side-chat-messages" ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
      {!messages.length && !loading && <div className="side-chat-welcome">
        <MessagesSquare size={27} strokeWidth={1.4} /><h3>{tr("在旁边聊，不打断工作", "Ask without interrupting")}</h3>
        <p>{mode === "task" ? tr("可以询问进度、解释错误，或讨论下一步。", "Ask about progress, errors or next steps.") : tr("问任何问题，不携带主任务的上下文。", "Ask without including the main task context.")}</p>
        {mode === "task" && <div className="side-chat-suggestions">{["现在做到哪了？", "解释最近的错误", "总结当前改动"].map((q) => <button key={q} onClick={() => updateDraft(q)}>{q}</button>)}</div>}
      </div>}
      {loading && <p className="side-chat-meta">{tr("正在读取侧聊历史…", "Loading side chat…")}</p>}
      {messages.map((message) => <article className={"side-chat-message " + message.role} key={message.id}>
        {message.role === "user" ? <p>{message.content}</p> : <>
          <div className="side-chat-answer-heading"><strong title={message.modelId || "AporiaX"}>AporiaX</strong>{message.status === "running" && <span>{tr("回答中", "Responding")}</span>}</div>
          {markdown(message.content, message.sources)}
          {message.error && <p className="side-chat-inline-error">{message.error}</p>}
          {message.status === "interrupted" && <small>{tr("回答已停止，主任务未受影响。", "Answer stopped; main task unaffected.")}</small>}
          <div className="side-chat-actions">
            <button title={tr("复制回答", "Copy answer")} aria-label={tr("复制回答", "Copy answer")} onClick={() => void copy(message)}>{copied === message.id ? <Check size={13} /> : <Copy size={13} />}</button>
            {message.sources?.length > 0 && <button onClick={() => showSource(message.sources.at(-1), message.sources)}>{tr("查看依据", "Sources")}</button>}
            {message.content && message.status !== "running" && onSendToMain && <button disabled={transferring} onClick={() => { setTransfer(message.content); showDialog({ kind: "transfer" }); }}>{tr("发送给主 Agent", "Send to main Agent")}<ArrowUpRight size={12} /></button>}
            {message.status !== "running" && <button aria-haspopup="dialog" aria-label={tr("回答详情", "Answer details")} title={tr("模型、用量与快照时间", "Model, usage and snapshot time")} onClick={() => showDialog({ kind: "answer", message })}><Info size={13} /></button>}
          </div>
        </>}
      </article>)}
      {pending && !running && <p className="side-chat-meta">{tr("正在连接侧聊模型…", "Connecting…")}</p>}
    </div>
    {error && <div className="side-chat-error" role="alert">{error}<button disabled={busy} onClick={() => { setError(""); setRetryLoad((n) => n + 1); }}>{tr("刷新", "Refresh")}</button></div>}
    <form className="side-chat-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <textarea ref={inputRef} rows={1} aria-label={tr("侧聊输入", "Side chat input")} placeholder={tr("问问 AporiaX…", "Message AporiaX…")} maxLength={8000} value={draft} onChange={(e) => updateDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <div className="side-chat-composer-footer">
        <SideChatModelPicker options={options} choice={choice} disabled={busy} onSelect={(value) => {
          setSelected(value); try { localStorage.setItem(scope + ":sidechat-model", value); } catch { setError("模型选择无法保存：本地存储不可用。"); }
        }} />
        {busy ? <button type="button" className="side-chat-submit" aria-label={tr("停止侧聊", "Stop side chat")} onClick={() => void cancel()}><Square size={14} /></button>
          : <button type="submit" className="side-chat-submit" aria-label={tr("发送侧聊", "Send side chat")} disabled={loading || !draft.trim() || !choice}><ArrowUp size={17} /></button>}
      </div>
    </form>

    {dialog && <SideChatDialog
      title={dialog.kind === "source" ? dialog.record.title : dialog.kind === "status" ? tr("任务状态", "Task status") : dialog.kind === "answer" ? tr("回答详情", "Answer details") : dialog.kind === "clear" ? tr("清空侧聊历史", "Clear side-chat history") : tr("确认转交主任务", "Confirm handoff")}
      label={dialog.kind === "source" ? tr("引用记录", "Source record") : undefined}
      subtitle={dialog.kind === "source" ? [states[dialog.record.status] || dialog.record.status, dialog.record.timestamp && clock(dialog.record.timestamp)].filter(Boolean).join(" · ") : dialog.kind === "status" ? task.title || tr("当前任务", "Current task") : undefined}
      onClose={closeDialog}
      footer={dialog.kind === "clear" || dialog.kind === "transfer" ? <>
        <button type="button" onClick={closeDialog}>{tr("取消", "Cancel")}</button>
        {dialog.kind === "clear" ? <button type="button" className="primary" disabled={busy || loading} onClick={() => void clearHistory()}>{tr("确认清空", "Confirm clear")}</button>
          : <button type="button" className="primary" disabled={transferring || !transfer.trim()} onClick={() => void sendToMain()}>{tr("确认发送", "Confirm send")}</button>}
      </> : undefined}>
      {dialog.kind === "source" && <div className="side-chat-source">
        <div className="side-chat-markdown">{dialog.record.detail ? markdown(dialog.record.detail, dialog.sources) : dialog.record.command ? <pre><code>{dialog.record.command}</code></pre> : <p>{tr("没有附加详情", "No additional details")}</p>}</div>
        {dialog.record.path && <button type="button" onClick={() => void openTarget(() => workbench.openFile(dialog.record.path))}>{dialog.record.path}<ArrowUpRight size={13} /></button>}
      </div>}
      {dialog.kind === "status" && <div className="side-chat-status">
        <dl><dt>{tr("任务状态", "Status")}</dt><dd>{states[snapshot.status] || snapshot.status}</dd>
          <dt>{tr("主任务模型", "Main model")}</dt><dd>{snapshot.modelId || tr("未报告", "Not reported")}</dd>
          <dt>{tr("当前阶段", "Stage")}</dt><dd>{snapshot.phase || "—"}</dd>
          <dt>{tr("最近活动", "Last activity")}</dt><dd>{clock(snapshot.lastActivityAt)} {activities[snapshot.activity] || ""}</dd></dl>
        {snapshot.agents.map((agent, i) => <p key={agent.id || i}>{agent.role || agent.id} · {states[agent.status] || agent.status} {agent.model}</p>)}
        <button type="button" onClick={() => { closeDialog(); workbench.open("route"); }}>{tr("打开 Route", "Open Route")} <ArrowUpRight size={12} /></button>
        <h3>{tr("最近 Witness / 工具记录", "Recent Witness / tool records")}</h3>
        {snapshot.records.length ? snapshot.records.slice(-8).reverse().map((record) => <button className="side-chat-record-row" type="button" key={record.id} onClick={() => showSource(record, snapshot.records)}><span>{record.title}</span><small>{states[record.status] || record.status}</small></button>) : <p>{tr("尚无运行记录。", "No run records yet.")}</p>}
      </div>}
      {dialog.kind === "answer" && <dl className="side-chat-answer-details">
        <dt>{tr("模型", "Model")}</dt><dd>{sideChatModelLabel(options.find((o) => o.providerId === dialog.message.providerId && o.modelId === dialog.message.modelId) || { id: dialog.message.modelId }) || tr("未报告", "Not reported")}{dialog.message.modelId && <small>{dialog.message.modelId}</small>}</dd>
        <dt>{tr("用量", "Usage")}</dt><dd>{Number.isFinite(dialog.message.usage?.total_tokens) ? dialog.message.usage.total_tokens.toLocaleString() + " tokens" : tr("用量未报告", "Usage not reported")}</dd>
        {dialog.message.capturedAt && <><dt>{tr("依据快照", "Snapshot")}</dt><dd>{clock(dialog.message.capturedAt)}</dd></>}
      </dl>}
      {dialog.kind === "clear" && <p>{tr("清空当前模式的侧聊历史？主任务不会改变。", "Clear this mode's history? The main task stays unchanged.")}</p>}
      {dialog.kind === "transfer" && <div className="side-chat-transfer">
        <p>{tr("提交后会成为主任务的新指令；你可以先编辑。", "Submitting creates a new main-task instruction. Edit it first if needed.")}</p>
        <textarea aria-label={tr("转交内容", "Handoff content")} disabled={transferring} value={transfer} onChange={(event) => setTransfer(event.target.value)} />
      </div>}
      {dialogError && <p className="side-chat-inline-error" role="alert">{dialogError}</p>}
    </SideChatDialog>}
  </section>;
}

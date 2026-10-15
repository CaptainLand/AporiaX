import React, { useRef, useState } from "react";
import { useI18n } from "../i18n";
import "./clarification-card.css";

export function ClarificationCard({ question, active, onRetry }) {
  const { tr } = useI18n();
  const [choice, setChoice] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(null);
  const submitting = useRef(false);
  const options = question.options || [];
  const custom = !options.length || choice === "custom";
  const answer = question.answer || submitted;
  const pending = question.status === "pending" && !answer;
  const valid = custom ? Boolean(text.trim()) : Boolean(choice);
  const submit = async (event) => {
    event.preventDefault();
    if (!valid || !pending || !active || submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    const value = custom ? { text: text.trim() } : { optionId: choice };
    try {
      if (!window.desktop?.harness?.respondToClarification) throw new Error("Unavailable");
      const result = await window.desktop.harness.respondToClarification({ runId: question.runId, questionId: question.id, answer: value });
      if (!result?.accepted) throw new Error("Rejected");
      setSubmitted({ text: custom ? text.trim() : options.find(option => option.id === choice).label });
    } catch {
      setError(tr("未能提交，请确认任务仍在等待后重试。你的填写已保留。", "Could not submit. Check that the task is still waiting and retry. Your input is retained."));
    } finally { submitting.current = false; setBusy(false); }
  };
  const cancel = async () => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try { await window.desktop.harness.interrupt(question.runId); }
    catch { setError(tr("未能停止任务，请重试。", "Could not stop the task. Please retry.")); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <section className="clarification-card" id={"clarification-" + question.id} aria-label={tr("任务提问", "Task question")}>
    <header><span>{pending ? tr("需要你的决定", "Your decision is needed") : answer ? tr("已回答", "Answered") : tr("已取消", "Cancelled")}</span><small>{question.ordinal || 1} / {question.limit || 2}</small></header>
    <h3>{question.question}</h3>
    <p className="clarification-reason">{question.reason}</p>
    {answer ? <p className="clarification-answer">{answer.text}</p> : pending && active ? <form onSubmit={submit}>
      <fieldset disabled={busy}>
        <legend className="visually-hidden">{tr("选择或填写你的回答", "Choose or write your answer")}</legend>
        {options.map(option => <label className="clarification-option" key={option.id}>
          <input type="radio" name={question.id} value={option.id} checked={choice === option.id} onChange={() => setChoice(option.id)} />
          <span>{option.label}{option.recommended && <small className="clarification-recommended">{tr("推荐", "Recommended")}</small>}{option.description && <small>{option.description}</small>}</span>
        </label>)}
        {options.length > 0 && <label className="clarification-option"><input type="radio" name={question.id} value="custom" checked={custom} onChange={() => setChoice("custom")} /><span>{tr("自己填写", "Write my own answer")}</span></label>}
        {custom && <textarea aria-label={tr("你的回答", "Your answer")} value={text} maxLength={4000} rows={3} onChange={event => setText(event.target.value)} placeholder={tr("填写关键要求即可，不要提供密码或密钥", "Key requirements only; do not enter passwords or API keys")} />}
      </fieldset>
      <footer><button type="button" disabled={busy} onClick={cancel}>{tr("停止任务", "Stop task")}</button><button className="clarification-submit" type="submit" disabled={!valid || busy}>{busy ? tr("提交中…", "Submitting…") : tr("提交并继续", "Submit and continue")}</button></footer>
      <p className="clarification-note">{tr("回答用于继续本任务，不代表授权执行命令。", "Your answer continues this task; it does not approve commands.")}</p>
    </form> : pending && <button type="button" disabled={busy || !onRetry} onClick={async () => { setBusy(true); try { await onRetry?.(); } finally { setBusy(false); } }}>{tr("继续任务并回答", "Resume task to answer")}</button>}
    {error && <p role="alert" className="clarification-error">{error}</p>}
  </section>;
}

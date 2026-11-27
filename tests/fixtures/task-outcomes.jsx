import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { Conversation, RouteView } from "../../src/conversation/ConversationViews.jsx";
import { replaceAssistantForRetry, updateTaskMessageById } from "../../src/state/task-store-core.js";
import { dismissStoppedRunNotice } from '../../src/state/task-outcome-view.js';
import { taskContinuationRequest } from '../../src/state/run-retry-core.js';
import "../../src/styles.css";
localStorage.setItem("aporiax.language.v1", "zh-CN");
const statuses = ["partial", "needs_input", "blocked", "completed", "failed", "interrupted"];
const task = { id: "fixture", messages: statuses.map((status) => ({ id: status, role: "assistant", status,
  content: status === "completed" ? "已交付 [成果](https://example.invalid/result)" : "状态测试", steps: [], changes: [],
  ...(status === "completed" ? { selfCheck: { delivery: { status: "unverified" } } } : {}) })) };
// Reply identity is independent of verification outcomes; those remain in
// execution records. Keep all old completion variants and the elapsed badge.
const completedReplies = [
  { delivery: { status: "unverified" } },
  { delivery: { status: "unavailable" } },
  { delivery: { status: "failed" } },
  { verification: { waived: true } },
  { delivery: { status: "passed" } },
  undefined,
].map((selfCheck, index) => ({ id: `reply-${index}`, role: "assistant", status: "completed", selfCheck,
  content: index === 0 ? "你好，有什么我可以帮你的吗？" : `完成回复 ${index}`,
  createdAt: "2026-10-06T00:00:00Z", completedAt: "2026-10-06T00:00:17Z", changes: [], steps: [] }));
const failure = { id: "old-failure", role: "assistant", status: "failed", error: true, prompt: "Create a document",
  sandbox: { recoveries: [{ directory: "D:/recovery/snapshot-1" }] },
  content: "Failed to deserialize the JSON body into the target type: messages[55]: missing field `content`",
  changes: [{ path: "资料 #1.docx", created: true, binary: true }, { path: "deleted.txt", deleted: true }],
  witness: { status: "failed", current: { eventType: "turn.failed", detail: "OLD_FAILURE_WITNESS" }, records: [] } };
window.desktop = { links: { activate: async (payload) => { window.openedOutcomeFile = payload; return { ok: true }; } } };
function RetryFixture() {
  const [current, setCurrent] = useState({ id: "retry", workspacePath: "D:/fixture", messages: [failure] });
  const running = current.messages.at(-1)?.status === "running";
  const followup = { id: "followup", role: "assistant", status: "running", content: "", witness: null };
  return <section id="retry-flow" style={{ maxWidth: 740, margin: "24px auto", padding: 20 }}>
    <nav style={{ display: "flex", gap: 12, marginBottom: 24 }}>
      <button onClick={() => setCurrent({ id: "retry", workspacePath: "D:/fixture", messages: [failure] })}>模拟失败</button>
      <button onClick={() => setCurrent((value) => ({ ...value, staleRunning: true }))}>残留运行标记</button>
      <button onClick={() => setCurrent((value) => ({ ...value, messages: [...value.messages, followup] }))}>继续任务</button>
      <button onClick={() => setCurrent((value) => ({ ...value, messages: value.messages.map((message) => message.id === "followup" ? {
        ...message, status: "completed", content: "后续轮次成功",
        usage: {prompt_tokens: 2763, completion_tokens: 186},
        cumulativeUsage: {prompt_tokens: 457103, completion_tokens: 26326, total_tokens: 483429, prompt_cache_hit_tokens: 445696},
        usageHistoryComplete: true,
        witness: { status: "completed", records: [{id:'finished',eventType:'turn.completed',kind:'status',status:'completed',elapsedMs:0}] },
      } : message) }))}>完成后续</button>
      <button onClick={() => setCurrent((value) => ({ ...value, messages: value.messages.map((message) => message.id === "retry-new" ? { ...message, status: "failed", error: true, content: "Provider unavailable" } : message) }))}>模拟启动失败</button>
      <button onClick={() => setCurrent({ id: "new-task", messages: [] })}>切换新任务</button>
    </nav>
    <Conversation task={current} isRunning={running || current.staleRunning} onRetry={() => setCurrent((value) => replaceAssistantForRetry(value, failure.id, { ...followup, id: "retry-new", prompt: failure.prompt }))} />
  </section>;
}

function SameRoundFixture() {
  const original = { id: 'same-original', runId: 'same-original-run', sourceUserId: 'same-user', role: 'assistant', status: 'partial',
    replySource: 'local-receipt', replyDelivered: true, content: 'Cloud interrupted after writing.',
    witness: { status: 'partial', records: [{ id: 'witness-1', kind: 'tool', tool: 'write_file', path: 'old-calculator.html', status: 'completed' }] } };
  const pending = { id: 'same-continued', runId: 'same-continued-run', recoveryOfRunId: original.runId, sourceUserId: 'same-user', role: 'assistant', status: 'running' };
  const [current, setCurrent] = useState({ id: 'same-task', messages: [{ id: 'same-user', role: 'user', content: 'Make a calculator' }, original] });
  const isRunning = current.messages.at(-1)?.status === 'running';
  return <section id="same-round" style={{ maxWidth: 740, margin: '24px auto', padding: 20 }}>
    <button onClick={() => setCurrent(task => replaceAssistantForRetry(task, original.id, pending))}>开始接续</button>
    <button onClick={() => setCurrent(task => ({ ...task, messages: task.messages.map(message => message.id === pending.id ? {
      ...message, status: 'completed', content: 'Calculations checked.',
      witness: { status: 'completed', records: [{ id: 'witness-1', kind: 'tool', tool: 'browser_open', path: 'continued-preview.html', status: 'completed' }] },
    } : message) }))}>写入新纪录</button>
    <div id="same-conversation"><Conversation task={current} isRunning={isRunning} /></div>
    <div id="same-execution"><RouteView task={current} isRunning={isRunning} /></div>
  </section>;
}

function StoppedNoticeFixture() {
  const stopped = { id: 'stopped-receipt', role: 'assistant', status: 'interrupted', replyDelivered: true, replySource: 'local-receipt',
    sourceUserId: 'stopped-source', runId: 'stopped-run', recoverable: { runId: 'stopped-run' },
    content: '后续执行中断。[calculator.html](<calculator.html>)', anchor: { id: 'stopped-anchor' },
    changes: [{ path: 'calculator.html', created: true }], steps: [],
    witness: { status: 'interrupted', records: [{ id: 'saved-file', kind: 'tool', tool: 'write_file', path: 'calculator.html', status: 'completed' }] } };
  const [current, setCurrent] = useState(() => ({ id: 'stopped-task', workspacePath: 'D:/fixture', messages: [
    { id: 'stopped-source', role: 'user', content: 'Make a calculator' },
    localStorage.getItem('fixture-stopped-dismissed') === 'true' ? dismissStoppedRunNotice(stopped) : stopped,
  ] }));
  const append = message => setCurrent(task => ({ ...task, messages: [...task.messages, message] }));
  window.stoppedTask = current;
  return <section id="stopped-notice" style={{ maxWidth: 740, margin: '24px auto' }}>
    <nav>
      <button onClick={() => append({ id: 'stopped-steering', role: 'user', content: 'Add exponents', steeringStatus: 'applied' })}>补充本轮要求</button>
      <button onClick={() => append({ id: 'new-user', role: 'user', content: 'hi' })}>发起新任务</button>
      <button onClick={() => append({ id: 'new-greeting', sourceUserId: 'new-user', role: 'assistant', status: 'completed', content: '你好。', usage: { prompt_tokens: 7, completion_tokens: 2 } })}>完成新任务</button>
    </nav>
    <div id="stopped-chat"><Conversation task={current} onRetry={message => { window.resumeStoppedRequest = taskContinuationRequest(current, message); }}
      onDismissStoppedNotice={(taskId, messageId) => {
        localStorage.setItem('fixture-stopped-dismissed', 'true');
        setCurrent(task => updateTaskMessageById([task], taskId, messageId, dismissStoppedRunNotice)[0]);
      }} /></div>
    <div id="stopped-history"><RouteView task={current} /></div>
  </section>;
}
createRoot(document.getElementById("root")).render(<I18nProvider>
  <section id="static-outcomes">{task.messages.map((message) => <Conversation key={message.id} task={{ id: message.id, messages: [message] }} />)}</section>
  <section id="completed-headings">{completedReplies.map((message) => <Conversation key={message.id} task={{ id: message.id, messages: [message] }} />)}</section>
  <section id="quota-receipt" style={{ maxWidth: 740, margin: '24px auto', padding: 20 }}>
    <Conversation onRetry={message => { window.continueRequest = taskContinuationRequest({ id: 'quota-receipt' }, message); }} task={{ id: 'quota-receipt', workspacePath: 'D:/fixture', messages: [{
      id: 'quota-receipt-message', role: 'assistant', status: 'partial', error: false, replyDelivered: true, replySource: 'local-receipt',
      runId: 'quota-original-run', sourceUserId: 'quota-user', prompt: 'Finish the game',
      content: '模型服务返回余额或额度不足，无法继续。请恢复对应服务的余额／额度，或切换模型后继续。\n\n已保留的文件改动（据本地执行记录整理，非模型最终答复）：\n\n- [super-mario.html](<super-mario.html>)\n\n本轮尚未全部完成，这份记录不表示文件已经验证通过。',
      changes: [{ path: 'super-mario.html', created: true }], steps: [],
      witness: { status: 'partial', records: [{ id: 'quota-ended', eventType: 'turn.completed', kind: 'status', status: 'partial', detail: '模型服务返回余额或额度不足，无法继续。', elapsedMs: 0 }] },
    }] }} />
  </section>
  <RetryFixture />
  <SameRoundFixture />
  <StoppedNoticeFixture />
</I18nProvider>);

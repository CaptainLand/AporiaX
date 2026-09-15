import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { Conversation } from "../../src/conversation/ConversationViews.jsx";
import { replaceAssistantForRetry } from "../../src/state/task-store-core.js";
import "../../src/styles.css";
localStorage.setItem("aporiax.language.v1", "zh-CN");
const statuses = ["partial", "needs_input", "blocked", "completed", "failed", "interrupted"];
const task = { id: "fixture", messages: statuses.map((status) => ({ id: status, role: "assistant", status,
  content: status === "completed" ? "已交付 [成果](https://example.invalid/result)" : "状态测试", steps: [], changes: [],
  ...(status === "completed" ? { selfCheck: { delivery: { status: "unverified" } } } : {}) })) };
const failure = { id: "old-failure", role: "assistant", status: "failed", error: true, prompt: "Create a document",
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
      <button onClick={() => setCurrent((value) => ({ ...value, messages: value.messages.map((message) => message.id === "followup" ? { ...message, status: "completed", content: "后续轮次成功", witness: { status: "completed", records: [] } } : message) }))}>完成后续</button>
      <button onClick={() => setCurrent((value) => ({ ...value, messages: value.messages.map((message) => message.id === "retry-new" ? { ...message, status: "failed", error: true, content: "Provider unavailable" } : message) }))}>模拟启动失败</button>
      <button onClick={() => setCurrent({ id: "new-task", messages: [] })}>切换新任务</button>
    </nav>
    <Conversation task={current} isRunning={running || current.staleRunning} onRetry={() => setCurrent((value) => replaceAssistantForRetry(value, failure.id, { ...followup, id: "retry-new", prompt: failure.prompt }))} />
  </section>;
}
createRoot(document.getElementById("root")).render(<I18nProvider>
  <section id="static-outcomes">{task.messages.map((message) => <Conversation key={message.id} task={{ id: message.id, messages: [message] }} />)}</section>
  <RetryFixture />
</I18nProvider>);

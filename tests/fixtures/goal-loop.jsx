import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { TaskGoalSettings } from "../../src/settings/TaskGoalSettings.jsx";
import { ProviderProtocolFields } from "../../src/settings/ProviderProtocolFields.jsx";
import { TaskGoalReport } from "../../src/conversation/TaskGoalReport.jsx";
import "../../src/styles.css";
localStorage.setItem("aporiax.language.v1", "en");
function Fixture() {
  const [task, setTask] = useState({ id: "fixture" }), [form, setForm] = useState({ protocol: "chat-completions", maxOutputTokens: 8192, anthropicThinking: "adaptive", thinkingBudget: 2048 });
  const [status, setStatus] = useState("");
  const save = async (event) => {
    event.preventDefault();
    const response = await fetch("/__goal/provider", { method: "POST", body: JSON.stringify({ ...form, maxOutputTokens: Number(form.maxOutputTokens), thinkingBudget: Number(form.thinkingBudget) }) });
    window.savedProvider = await response.json(); setStatus(response.ok ? "Provider saved" : window.savedProvider.error);
  };
  return <main className="goal-ui-fixture" style={{ margin: "auto", width: "min(100%,760px)", padding: 12, boxSizing: "border-box" }}>
    <TaskGoalSettings task={task} onUpdateTask={(update) => setTask((current) => { const next = { ...current, ...update }; window.savedTask = next; return next; })} />
    <form onSubmit={save}><ProviderProtocolFields form={form} setForm={setForm} /><button type="submit">Save provider fixture</button><p role="status">{status}</p></form>
    <TaskGoalReport brief={{ entries: [{ id: "decision-1", summary: "Preserve original input", rationale: '<img src=x onerror="window.badInjection=true">', evidence: [{ callId: "read-original", tool: "read_file", historical: true }] }] }}
      acceptance={{ passed: false, requirements: [{ id: "r1", text: "Respect configured requirement", status: "needs-human-review", checks: [] }] }} strategy={{ pending: { reason: "Repeated failure; inspect new evidence" } }} />
  </main>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);

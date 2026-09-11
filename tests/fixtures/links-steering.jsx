import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { Conversation } from "../../src/conversation/ConversationViews.jsx";
import { useHarnessEvents } from "../../src/hooks/useHarnessEvents.js";

localStorage.setItem("aporiax.language.v1", "zh-CN");
window.linkCalls = [];
window.desktop = {
  links: { activate: async (request) => {
    window.linkCalls.push(request);
    return request.href.includes("missing") ? { ok: false, error: "File does not exist" } : { ok: true };
  } },
  harness: { onEvent: (listener) => { window.fixtureEmit = listener; return () => {}; } },
};
const noop = () => {};
const translate = (zh) => zh;
function Fixture() {
  const [tasks, setTasks] = useState([{ id: "t", workspacePath: "D:/Agent开发", messages: [
    { id: "u", role: "user", content: "Build it" },
    { id: "a", role: "assistant", status: "running", content: "[便携版](D:/项目/app.exe) [代码](src/main.jsx:42) [网页](https://example.com) [缺失](D:/missing.txt)", steps: [], changes: [], route: [], progressUpdates: [] },
  ] }]);
  const runsRef = useRef(new Map([["r", { taskId: "t", assistantId: "a" }]]));
  useHarnessEvents({ language: "zh-CN", tr: translate, runsRef, setTasks, setRunPaused: noop, setRunStatus: noop, setSandboxStatus: noop, setApproval: noop, normalizeWorkspacePath: (p) => p });
  window.fixtureInsert = () => setTasks((current) => current.map((t) => ({ ...t, messages: [...t.messages, { id: "s", role: "user", content: "改为便携版", steeringStatus: "pending" }] })));
  window.fixtureTasks = tasks;
  return <Conversation task={tasks[0]} isRunning={false} approval={null} onRetry={noop} onRevert={noop} onRestoreTurnAnchor={noop} onConfirmChanges={noop} onSaveChanges={noop} onNotice={noop} />;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);

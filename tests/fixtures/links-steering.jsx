import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { Conversation } from "../../src/conversation/ConversationViews.jsx";
import { useHarnessEvents } from "../../src/hooks/useHarnessEvents.js";
import { WorkbenchContext, useWorkbench } from "../../src/workbench/use-workbench.js";

localStorage.setItem("aporiax.language.v1", "zh-CN");
window.linkCalls = [];
window.desktop = {
  workbench: { subscribe: () => () => {}, request: async (request) => {
    window.workbenchCalls.push(request);
    if (request.action === "list") return [];
    if (request.action === "file-check") return { status: request.path.includes("missing") ? "missing" : "exists" };
    return {};
  } },
  links: { activate: async (request) => {
    window.linkCalls.push(request);
    return request.href.includes("missing") ? { ok: false, error: "File does not exist" } : { ok: true };
  } },
  harness: { onEvent: (listener) => { window.fixtureEmit = listener; return () => {}; } },
};
const noop = () => {};
window.workbenchCalls = [];
const translate = (zh) => zh;
function Fixture() {
  const [tasks, setTasks] = useState([{ id: "t", workspacePath: "D:/Agent开发", messages: [
    { id: "u", role: "user", content: "Build it" },
    { id: "a", role: "assistant", status: "running", content: "[便携版](D:/项目/app.exe) [代码](src/main.jsx:42) [网页](https://example.com) [缺失](D:/missing.txt) http://localhost:8080/todo.html（仅本机可访问；8080\n\n- [SeaLandX-B站用户资料简介-美化版.docx](SeaLandX-B站用户资料简介-美化版.docx)（43,703 字节）\n- [报告 🚀](<报告 🚀 #1 %25.docx>)\n- [中文网页](https://example.com/资料（新版）)\n- [引用文件][doc]\n\n[doc]: <文件夹/my report (1).docx>", steps: [], changes: [], route: [], progressUpdates: [] },
  ] }]);
  const runsRef = useRef(new Map([["r", { taskId: "t", assistantId: "a" }]]));
  useHarnessEvents({ language: "zh-CN", tr: translate, runsRef, setTasks, setRunPaused: noop, setRunStatus: noop, setSandboxStatus: noop, setApproval: noop, normalizeWorkspacePath: (p) => p });
  window.fixtureInsert = () => setTasks((current) => current.map((t) => ({ ...t, messages: [...t.messages, { id: "s", role: "user", content: "改为便携版", steeringStatus: "pending" }] })));
  window.fixtureTasks = tasks;
  const workbench = useWorkbench(tasks[0]);
  window.fixtureWorkbench = workbench;
  return <WorkbenchContext.Provider value={location.search.includes("workbench") ? workbench : null}><Conversation task={tasks[0]} isRunning={false} approval={null} onRetry={noop} onRevert={noop} onRestoreTurnAnchor={noop} onConfirmChanges={noop} onSaveChanges={noop} onNotice={noop} /></WorkbenchContext.Provider>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);

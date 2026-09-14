import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { WorkbenchLayout } from "../../src/workbench/WorkbenchLayout.jsx";
import { WorkbenchContext, useWorkbench } from "../../src/workbench/use-workbench.js";
import "../../src/styles.css";
localStorage.clear();
localStorage.setItem("aporiax.language.v1", "zh-CN");
window.calls = [];
window.handoffs = [];
const harnessListeners = new Set();
window.emitHarness = (event) => harnessListeners.forEach((fn) => fn(event));
window.desktop = {
  workspace: { readPreview: async (workspacePath, path) => { window.calls.push({ channel: "workspace", action: "readPreview", workspacePath, path }); return { content: "<h1>Preview from source link</h1>", binary: false }; } },
  harness: { onEvent: (fn) => { harnessListeners.add(fn); return () => harnessListeners.delete(fn); } },
  sideChat: {
    request: async (input) => {
      window.calls.push({ channel: "sideChat", ...input });
      const response = await fetch("/__side-chat/request", { method: "POST", body: JSON.stringify(input) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    },
    subscribe: (fn) => {
      const stream = new EventSource("/__side-chat/events");
      stream.onmessage = (event) => fn(JSON.parse(event.data));
      return () => stream.close();
    },
  },
  workbench: {
    subscribe: () => () => {},
    request: async (input) => { window.calls.push({ channel: "workbench", ...input }); return input.action === "list" ? [] : true; },
  },
};
const providers = [
  { id: "fixture-provider", name: "DeepSeek", models: [{ id: "fixture-model", name: "deepseek-v4.1-flash-expires-on-0910" }, { id: "fixture-pro", name: "DeepSeek Pro", shortName: "DeepSeek Pro" }] },
  { id: "local-provider", name: "本地模型", source: "local", models: [{ id: "local-test-model", name: "Local Test" }] },
];
const makeTask = (id) => ({
  id, title: id === "side-fixture" ? "交付预览页面" : "第二个任务",
  workspacePath: "D:/SideChatFixture", providerId: "fixture-provider", modelId: "fixture-model",
  messages: [{ id: "request", role: "user", content: "做好页面并给我预览链接。" }, { id: "assistant", role: "assistant", runId: "main-run", status: "running", content: "页面已交付。\n\n- [预览页面](index.html)\n\n**检查结果**：可打开。\n\n" + Array(16).fill("一段用于检查弹窗内部滚动的运行记录。").join("\n\n") + '\n\n<script>window.sourceScriptRan = true</script>',
    witness: { phase: "work", lastMeaningfulAt: "2026-09-14T08:00:00Z", agents: [{ id: "builder", role: "Builder", status: "running" }],
      records: [{ id: "read", title: "已读取页面", status: "completed", detail: "Read index.html, 42 lines.", completedAt: "2026-09-14T08:00:00Z" }] },
  }],
});
function Fixture() {
  const [task, setTask] = useState(() => makeTask("side-fixture"));
  const [ticks, setTicks] = useState(0);
  const wb = useWorkbench(task);
  window.wb = wb;
  window.switchTask = (id) => setTask(makeTask(id));
  useEffect(() => { wb.expand(); }, [wb.key]);
  useEffect(() => { const timer = setInterval(() => setTicks((n) => n + 1), 100); return () => clearInterval(timer); }, []);
  return <WorkbenchContext.Provider value={wb}>
    <style>{"html,body,#root{height:100%;margin:0;font-family:'Segoe UI','Microsoft YaHei',sans-serif}*{box-sizing:border-box}.task-workspace{display:flex;height:100vh}.thread{flex:1;min-width:420px;padding:28px;background:var(--bg,#f8f7f8)}.workbench-shell{height:100vh}.thread p{margin:12px 0}.fixture-summary{max-width:390px;color:#77727e;line-height:1.8}.fixture-action{padding:8px;margin-right:8px;border:1px solid #dedce2;border-radius:6px}"}</style>
    <div className="task-workspace">
      <div className="thread">
        <h2>AporiaX · 主任务</h2>
        <p className="fixture-summary">正在完成预览页面。侧边问答和主任务相互独立，只有确认转交后，才会收到新指令。</p>
        <div className="user-message"><div className="message-bubble">查看工作进度</div></div>
        <div className="assistant-message-content">正在准备预览，完成后会给出链接。</div>
        <p>主任务活动：<output id="main-ticks">{ticks}</output></p>
        <p>收到指令：{window.handoffs.length}</p>
        <button className="fixture-action" onClick={() => wb.expand()}>打开侧栏</button>
        <button className="fixture-action" onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; }}>切换主题</button>
      </div>
      {wb.layout.open && <WorkbenchLayout workbench={wb} builtins={{ route: <p>主任务 Route，继续运行。</p> }} sideChat={{
        providers, isRunning: true, onSendToMain: async (content) => { window.handoffs.push(content); return true; },
      }} />}
    </div>
  </WorkbenchContext.Provider>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);

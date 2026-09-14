import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { WorkbenchLayout } from "../../src/workbench/WorkbenchLayout.jsx";
import { useWorkbench, WorkbenchContext } from "../../src/workbench/use-workbench.js";
import "../../src/styles.css";
localStorage.clear(); localStorage.setItem("aporiax.language.v1", "zh-CN");
const task = await fetch("/__fixture/meta").then((result) => result.json());
window.calls = [];
async function bridge(input) {
  window.calls.push(input);
  const response = await fetch("/__fixture/request", { method: "POST", body: JSON.stringify(input) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
window.desktop = {
  workspace: { readPreview: (workspacePath, path) => bridge({ action: "preview", workspacePath, path }), saveText: (input) => bridge({ action: "save", ...input }) },
  workbench: { subscribe: () => () => {}, request: bridge },
  links: { activate: async (input) => { window.calls.push({ action: "native", ...input }); } },
};
function Fixture() {
  const wb = useWorkbench(task); window.wb = wb;
  useEffect(() => wb.expand(), []);
  return <WorkbenchContext.Provider value={wb}>
    <style>{'html,body,#root{margin:0;height:100%}.task-workspace{display:flex;height:100vh}.thread{padding:32px;min-width:420px;flex:1}.thread button{display:block;padding:10px 16px;margin:12px 0;border:1px solid #dedce2;border-radius:8px}.workbench-shell{height:100vh}.thread p{max-width:320px;line-height:1.8;color:#77727e}'}</style>
    <div className="task-workspace"><div className="thread"><h2>AporiaX · 文档与 Git</h2><p>任务继续工作，交付物可以直接在侧栏阅读。</p><button onClick={() => wb.openFile("docs/guide.md")}>查看 Markdown</button><button onClick={() => wb.openFile("report.docx")}>查看 Word</button><button onClick={() => wb.openFile("broken.docx")}>损坏 Word</button></div>
    {wb.layout.open && <WorkbenchLayout workbench={wb} builtins={{}} onNotice={() => {}} />}</div>
  </WorkbenchContext.Provider>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);

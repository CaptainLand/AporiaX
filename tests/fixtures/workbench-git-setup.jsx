import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { WorkbenchLayout } from "../../src/workbench/WorkbenchLayout.jsx";
import { useWorkbench, WorkbenchContext } from "../../src/workbench/use-workbench.js";
import "../../src/styles.css";
localStorage.clear(); localStorage.setItem("aporiax.language.v1", "zh-CN");
const task = await fetch("/__fixture/meta" + location.search).then((result) => result.json());
window.calls = [];
async function request(input) {
  window.calls.push(input);
  const result = await fetch("/__fixture/request", { method: "POST", body: JSON.stringify(input) });
  const data = await result.json(); if (!result.ok) throw new Error(data.error); return data;
}
window.desktop = {
  workbench: { request, subscribe: () => () => {} },
  workspace: { readPreview: (workspacePath, path) => request({ action: "preview", workspacePath, path }), saveText: (input) => request({ action: "save", ...input }) },
};
function Fixture() {
  const wb = useWorkbench(task); window.wb = wb;
  useEffect(() => wb.expand(), []);
  return <WorkbenchContext.Provider value={wb}>
    <style>{'html,body,#root{margin:0;height:100%}.task-workspace{display:flex;height:100vh}.thread{padding:32px;min-width:420px;flex:1}.thread p{line-height:1.8;color:#77727e}.workbench-shell{height:100vh}'}</style>
    <div className="task-workspace"><div className="thread"><h2>AporiaX · Git</h2><p>分支、远程和 GitHub 连接。</p></div><WorkbenchLayout workbench={wb} builtins={{}} onNotice={() => {}} /></div>
  </WorkbenchContext.Provider>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);

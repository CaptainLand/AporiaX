import React from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { WorkbenchLayout } from "../../src/workbench/WorkbenchLayout.jsx";
import { useWorkbench, WorkbenchContext } from "../../src/workbench/use-workbench.js";
import { UserAttachments } from "../../src/agent-components.jsx";
import "../../src/styles.css";
localStorage.clear();
localStorage.setItem("aporiax.language.v1", "zh-CN");
window.calls = [];
window.failStop = false;
const listeners = new Set();
const task = { id: "fixture", workspacePath: "D:/Fixture" };
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
const resources = {};
const source = "/* multiline\n * comment */\nconst greeting = 'AporiaX';\nfunction hello(value) {\n  return value + 42;\n}\n";
window.desktop = {
  workspace: {
    readPreview: async (root, path) => {
      if (path === "missing.js") throw new Error("File does not exist");
      return { content: path === "b.js" ? "// second\nconst b = 2;" : source, path, truncated: path === "readonly.js", readOnly: path === "readonly.js" };
    },
    saveText: async (input) => { window.calls.push(input); if (window.failSave) throw new Error("File changed externally"); return { content: input.content, path: input.requestedPath }; },
  },
  workbench: {
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    request: async (input) => {
      window.calls.push(input);
      const r = resources[input.id];
      if (input.action === "list") return Object.values(resources);
      if (input.action === "new-terminal" || input.action === "new-browser") {
        const kind = input.action.slice(4), id = kind + "_" + (Object.keys(resources).length + 1);
        return resources[id] = { id, kind, title: id, cwd: task.workspacePath, owner: "user", status: "running", taskId: task.id, workspacePath: task.workspacePath };
      }
      if (input.action === "stop") {
        if (window.failStop) throw new Error("Fixture close failed");
        delete resources[input.id]; return { status: "closed" };
      }
      if (input.action === "read") {
        const output = "\x1b[36m" + input.id + " READY\x1b[0m\r\nPS D:\\Fixture> ";
        return { ...r, output: input.cursor ? "" : output, cursor: output.length };
      }
      if (input.action === "file") {
        if (!input.approveExternal) throw new Error("Path escapes the authorized workspace");
        return { kind: "image", mime: "image/png", data: image.split(",")[1] };
      }
      if (input.action === "search") {
        await new Promise((r) => setTimeout(r, input.query === "old" ? 500 : 20));
        return { entries: [{ path: input.query + ".js" }] };
      }
      return true;
    },
  },
};
function Fixture() {
  const wb = useWorkbench(task);
  window.wb = wb;
  return <I18nProvider><WorkbenchContext.Provider value={wb}>
    <style>{`html,body,#root{margin:0;height:100%;font-family:"Segoe UI",sans-serif}*{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer}.task-workspace{display:flex;height:100vh}.thread{flex:1;padding:28px;background:#f8f7f8;min-width:420px}.workbench-shell{height:100vh}.message-attachment-grid img{width:60px;height:60px}.workbench-editor{outline:0}`}</style>
    <div className="task-workspace">
      <div className="thread">
        <h2>AporiaX · 侧栏回归</h2>
        <input aria-label="对话输入" placeholder="输入消息" />
        <UserAttachments attachments={[{ name: "附件.png", kind: "image", dataUrl: image }]} onOpenImage={wb.openImage} />
        <button onClick={() => wb.openFile("a.js")}>打开代码</button>
        <button onClick={() => wb.open("workspace")}>文件搜索</button>
      </div>
      {wb.layout.open && <WorkbenchLayout workbench={wb} builtins={{ workspace: <div>Workspace tree</div> }} onNotice={() => {}} />}
    </div>
  </WorkbenchContext.Provider></I18nProvider>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);

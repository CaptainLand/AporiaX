import React from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { WorkbenchLayout } from "../../src/workbench/WorkbenchLayout.jsx";
import { useWorkbench } from "../../src/workbench/use-workbench.js";
import { peekTerminalSession } from "../../src/workbench/terminal-session.js";
import "../../src/styles.css";
localStorage.clear(); localStorage.setItem("aporiax.language.v1", "zh-CN");
const resources = {}, listeners = new Set(); let nextId = 0;
window.calls = []; window.clipboardText = ""; window.failStop = false; window.readFailures = 0;
const task = window.nativeTerminalTask || { id: "terminal-v2", workspacePath: "D:/Fixture" };
window.resource = (id) => resources[id];
window.appendOutput = (id, output) => { resources[id].output += output; };
window.presentTerminal = () => { const value = createResource(); value.present = true; listeners.forEach((listener) => listener(value)); return value.id; };
function createResource() {
  const id = "terminal_" + ++nextId;
  return resources[id] = { ...task, id, taskId: task.id, kind: "terminal", title: "PowerShell · Fixture", cwd: task.workspacePath, owner: "user", status: "running", output: "\x1b[36mAporiaX terminal\x1b[0m\r\nPS D:\\Fixture> " };
}
if (!window.desktop?.workbench) window.desktop = { workbench: {
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  async request(input) {
    window.calls.push(input); const resource = resources[input.id];
    if (input.action === "list") return Object.values(resources);
    if (input.action === "new-terminal") return createResource();
    if (input.action === "hide") return true;
    if (!resource) return { missing: true };
    if (input.action === "read") {
      if (window.readFailures-- > 0) throw new Error("Temporary fixture transport error");
      const start = Math.max(0, input.cursor || 0), cursor = Math.min(resource.output.length, start + 80000);
      return { ...resource, output: resource.output.slice(start, cursor), cursor, endCursor: resource.output.length, hasMore: cursor < resource.output.length };
    }
    if (input.action === "terminal-paste") return { text: window.clipboardText };
    if (input.action === "write" && window.echoInputs && !/[\u0000-\u001f\u007f]/.test(input.data)) {
      setTimeout(() => { resource.output += input.data; }, 40);
      return true;
    }
    if (input.action === "terminal-copy") { window.clipboardText = input.text; return true; }
    if (input.action === "terminal-rename") { resource.title = input.text; listeners.forEach((fn) => fn(resource)); return resource; }
    if (input.action === "stop") { if (window.failStop) throw new Error("Cannot close fixture"); delete resources[input.id]; return { status: "closed" }; }
    return true;
  },
} };
function Fixture() {
  const wb = useWorkbench(task); window.wb = wb; window.terminal = (id = wb.layout.active) => peekTerminalSession(wb.key, id);
  return <><style>{'html,body,#root{margin:0;height:100%}.task-workspace{display:flex;height:100vh}.thread{flex:1;min-width:420px;padding:32px}.thread input{padding:10px}.workbench-shell{height:100vh}'}</style>
    <div className="task-workspace"><div className="thread"><h2>AporiaX</h2><p>终端 · 会话与交互验证</p><input aria-label="对话输入" /><button onClick={() => wb.create("terminal")}>新建测试终端</button></div>
      {wb.layout.open && <WorkbenchLayout workbench={wb} builtins={{ route: <p>Changes fixture</p> }} onNotice={() => {}} />}</div></>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);

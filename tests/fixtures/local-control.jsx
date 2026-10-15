import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { ExternalControlPanel } from "../../src/control/ExternalControlPanel.jsx";
import { SettingsPanel } from "../../src/settings/SettingsPanel.jsx";
import { getDefaultTaskConfig } from "../../src/models/model-catalog.js";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
localStorage.setItem("aporiax.language.v1", params.get("lang") || "zh-CN");
document.documentElement.dataset.theme = params.get("theme") || "light";
const listeners = new Set();
const emit = event => { for (const listener of listeners) listener(event); };
const state = {
  enabled: false, endpoint: "http://127.0.0.1:34567", instanceId: "instance-fixture",
  workspaces: params.has("empty") ? [] : [{ id: "ws-fixture", path: "D:/Projects/Aporia Cloud", label: "Aporia Cloud", source: "aporiax" }], clients: [], runs: [],
  fileAccess: { enabled: false },
  providers: [{ id: "provider-fixture", name: "Fixture provider", models: [{ id: "model-fixture", name: "Fixture model" }] }],
  limits: { maxDurationSeconds: 1800, maxModelCalls: 80, maxToolCalls: 400, maxParallelAgents: 2, maxSubagents: 12 },
};
const calls = [];
const errors = new Map();
const copied = [];
const openedWorkspaces = [];
const questions = new Map();
const approvals = new Map();
Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => { copied.push(text); } }, configurable: true });
const clone = value => JSON.parse(JSON.stringify(value));
window.desktop = {
  selectDirectory: async () => "D:/Projects/Aporia Cloud",
  openWorkspace: async path => { openedWorkspaces.push(path); return true; },
  control: {
    subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    request: async ({ action, input = {} }) => {
      calls.push({ action, input: clone(input) });
      if (errors.has(action)) { const message = errors.get(action); errors.delete(action); throw new Error(message); }
      const run = state.runs.find(item => item.runId === input.runId);
      if (action === "status") return clone(state);
      if (action === "getFileAccess") return clone(state.fileAccess);
      if (action === "setFileAccess") {
        if (input.enabled && input.riskAcknowledged !== true) throw new Error("Risk confirmation required");
        state.fileAccess.enabled = input.enabled;
        emit({ type: "file-access.updated" }); return clone(state.fileAccess);
      }
      if (action === "setEnabled") { state.enabled = input.enabled; emit({ type: "control.updated" }); return { enabled: state.enabled }; }
      if (action === "registerWorkspace") { const value = { id: "ws-fixture", path: input.path, label: input.label, createdAt: new Date().toISOString() }; state.workspaces = [value]; return clone(value); }
      if (action === "removeWorkspace") { state.workspaces = state.workspaces.filter(item => item.id !== input.workspaceId); return { ok: true }; }
      if (action === "createClient") {
        const client = { ...input, id: `client-${state.clients.length + 1}`, createdAt: new Date().toISOString(), revokedAt: null };
        state.clients.push(client);
        return { client: clone(client), token: "fixture-credential-only", connectionFile: "D:/AporiaX/connections/client.json", discoveryPath: "D:/AporiaX/discovery.json", connectionConfig: {
          mcpJson: JSON.stringify({ mcpServers: { aporiax: { command: "D:/AporiaX/AporiaX.exe", args: ["bridge.js", "mcp", "--connection", "D:/AporiaX/connections/client.json"], env: { ELECTRON_RUN_AS_NODE: "1" } } } }, null, 2),
          codexToml: '[mcp_servers.aporiax]\ncommand = "D:/AporiaX/AporiaX.exe"\nargs = ["bridge.js", "mcp", "--connection", "D:/AporiaX/connections/client.json"]',
          apiBaseUrl: "http://127.0.0.1:34567/control/v1", apiExample: 'curl -H "Authorization: Bearer fixture-credential-only" http://127.0.0.1:34567/control/v1/runs',
        } };
      }
      if (action === "revokeClient") { const client = state.clients.find(item => item.id === input.clientId); client.revokedAt = new Date().toISOString(); for (const active of state.runs.filter(item => item.clientId === client.id && item.status === "running")) active.status = "cancelled"; return { ok: true }; }
      if (!run) throw new Error("Unknown fixture run");
      if (action === "getRun") return clone(run);
      if (action === "getResult") return { runId: run.runId, status: run.status, result: { status: run.status, summary: "检查完成：补丁位于独立工作区，源目录没有自动修改。", verification: { status: "passed", command: "npm test" }, changes: [{ path: "src/auth.js" }] }, artifacts: [{ id: "artifact-fixture", name: "changes.patch", bytes: 256 }] };
      if (action === "getAgents") return { agents: [{ id: "agent-fixture", role: "reviewer", status: "completed" }] };
      if (action === "getQuestions") return { questions: clone(questions.get(run.runId) || []) };
      if (action === "getApprovals") return { approvals: clone(approvals.get(run.runId) || []) };
      if (action === "getEvents") { const all = Array.from({ length: 205 }, (_, index) => ({ seq: index + 1, at: "2026-09-28T11:00:00Z", type: index ? "agent.progress" : "run.created", payload: { progress: index } })); const events = all.filter(event => event.seq > (input.afterSeq || 0)).slice(0, input.limit || 100); return { runId: run.runId, events, nextSeq: events.at(-1)?.seq || input.afterSeq || 0, hasMore: (events.at(-1)?.seq || input.afterSeq || 0) < all.length }; }
      if (action === "pauseRun") run.status = "paused";
      else if (action === "resumeRun") run.status = "running";
      else if (action === "cancelRun") run.status = "cancelled";
      else if (action === "answerQuestion") { const question = questions.get(run.runId).find(item => item.id === input.questionId); question.status = "answered"; question.answer = { text: input.answer.text || question.options.find(option => option.id === input.answer.optionId)?.label }; run.status = "running"; }
      else if (action === "respondApproval") { approvals.set(run.runId, []); run.status = "running"; }
      else if (action !== "sendMessage") throw new Error(`Unhandled fixture action: ${action}`);
      emit({ type: "run.updated", runId: run.runId });
      return { ok: true };
    },
  },
};
if (params.has("unavailable")) delete window.desktop.control;
window.localControlFixture = {
  calls, copied, openedWorkspaces, state,
  rejectNext(action, message) { errors.set(action, message); },
  addRun() {
    const run = { runId: "run-external", taskId: "external-task-not-in-renderer-store", clientId: state.clients[0]?.id || "client-fixture", clientName: "Codex", workspaceId: "ws-fixture", profile: "workspace", instruction: "检查鉴权与计费并生成修复补丁", status: "waiting_question", executionWorkspacePath: "D:/AporiaX/runs/run-external/workspace", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    state.runs = [run];
    questions.set(run.runId, [{ id: "question-fixture", question: "验证使用哪个环境？", reason: "需要确定验证目标。", status: "pending", options: [{ id: "staging", label: "预发布环境", description: "使用隔离的测试数据。" }] }]);
    approvals.set(run.runId, [{ approvalId: "approval-fixture", runId: run.runId, approval: { id: "approval-fixture", kind: "command", tool: "run_command", title: "运行项目测试", command: "npm test", cwd: run.executionWorkspacePath } }]);
    emit({ type: "run.created", runId: run.runId });
    return run.runId;
  },
  openRun(runId) { emit({ type: "open", runId }); },
};

function Fixture() {
  const [open, setOpen] = useState(true);
  const [runId, setRunId] = useState("");
  const [task, setTask] = useState({ ...getDefaultTaskConfig([]), id: "fixture", workspaceName: "Aporia Cloud", workspacePath: "D:/Projects/Aporia Cloud" });
  useEffect(() => window.desktop.control?.subscribe(event => { if (event.type === "open") { setRunId(event.runId); setOpen(true); } }), []);
  return <><button type="button" onClick={() => { setRunId(""); setOpen(true); }}>Open external connections</button><SettingsPanel task={task} providers={[]} onUpdateTask={patch => setTask(current => ({ ...current, ...patch }))} onClose={() => {}} sandboxStatus={{ localAvailable: true }} style={{ width: 304, height: "90vh" }} />{open && <ExternalControlPanel initialRunId={runId} onClose={() => setOpen(false)} />}</>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);

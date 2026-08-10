import assert from "node:assert/strict";
import {
  createPermissionPolicy,
  getToolPermission,
} from "../electron/agent-core.js";
import {
  buildToolApprovalRequest,
  resolveToolExecutionPermission,
} from "../electron/runtime/tool-permissions.js";
import {
  buildAgentProcessSummary,
  deriveLiveAgentStatus,
} from "../src/agent-process-model.js";

const workspaceWrite = createPermissionPolicy("workspace-write");
assert.equal(getToolPermission(workspaceWrite, "run_command"), "allow");
assert.equal(getToolPermission(workspaceWrite, "write_file"), "allow");
assert.equal(getToolPermission(workspaceWrite, "browser_click"), "ask");

const builderWrite = createPermissionPolicy("builder-write");
assert.equal(getToolPermission(builderWrite, "run_command"), "allow");
assert.equal(getToolPermission(builderWrite, "browser_click"), "deny");
assert.equal(getToolPermission(builderWrite, "delegate_subagent"), "deny");

const dockerAuto = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  sandboxStatus: { available: true, autoApprovalSafe: true },
});
assert.equal(dockerAuto.denied, false);
assert.equal(dockerAuto.requiresApproval, false);
assert.equal(dockerAuto.sandboxAutoApproved, true);
assert.equal(dockerAuto.executionMode, "container-auto-approval");

const localAuto = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  sandboxStatus: { available: false, localAvailable: true, autoApprovalSafe: true },
});
assert.equal(localAuto.requiresApproval, false);
assert.equal(localAuto.executionMode, "local-workspace-auto-approval");

const manualSandbox = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "allow",
  approvalMode: "manual",
  sandboxStatus: { localAvailable: true, autoApprovalSafe: true },
});
assert.equal(manualSandbox.requiresApproval, true);
assert.equal(manualSandbox.executionMode, "sandbox-manual-approval");

const noSandbox = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  sandboxStatus: null,
});
assert.equal(noSandbox.requiresApproval, true);
assert.equal(noSandbox.executionMode, "host-manual-approval");

const browserControl = resolveToolExecutionPermission({
  toolName: "browser_click",
  permissionAction: "ask",
  approvalMode: "sandbox-auto",
  sandboxStatus: { localAvailable: true },
});
assert.equal(browserControl.requiresApproval, true);

const denied = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "deny",
  approvalMode: "sandbox-auto",
  sandboxStatus: { available: true },
});
assert.equal(denied.denied, true);
assert.equal(denied.requiresApproval, false);

assert.deepEqual(
  buildToolApprovalRequest({
    toolName: "run_command",
    descriptor: { risk: "execute" },
    input: { command: "npm test", cwd: "." },
    sandboxStatus: { backend: "local-workspace" },
  }),
  {
    kind: "execute",
    title: "运行工作区命令",
    command: "npm test",
    cwd: ".",
    reason: "Agent 请求执行可能改变工作区或运行进程的操作。",
    sandbox: { backend: "local-workspace" },
  },
);

const genericCompletedMessage = {
  id: "assistant-generic",
  status: "completed",
  witness: {
    records: [
      {
        id: "start",
        kind: "status",
        eventType: "turn.started",
        status: "completed",
      },
      {
        id: "done",
        kind: "status",
        eventType: "turn.completed",
        status: "completed",
      },
    ],
  },
  route: [],
  changes: [],
};
assert.deepEqual(buildAgentProcessSummary(genericCompletedMessage, "zh-CN"), []);
assert.equal(deriveLiveAgentStatus(genericCompletedMessage, "zh-CN").detail, "");

const meaningfulMessage = {
  id: "assistant-real",
  status: "completed",
  witness: {
    records: [
      {
        id: "read",
        kind: "tool",
        tool: "read_file",
        path: "src/main.jsx",
        status: "completed",
      },
      {
        id: "verify",
        kind: "tool",
        tool: "run_command",
        command: "npm run build",
        status: "completed",
      },
    ],
  },
  route: [],
  changes: [],
};
const meaningfulSteps = buildAgentProcessSummary(meaningfulMessage, "zh-CN");
assert.equal(meaningfulSteps.length, 2);
assert.equal(meaningfulSteps[0].paths[0], "src/main.jsx");
assert.equal(meaningfulSteps[1].commands[0], "npm run build");

console.log("tool permissions + process UI smoke: PASS");

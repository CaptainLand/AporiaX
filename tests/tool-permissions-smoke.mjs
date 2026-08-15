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
assert.equal(getToolPermission(workspaceWrite, "browser_click"), "allow");
assert.equal(getToolPermission(workspaceWrite, "browser_fill"), "allow");
assert.equal(getToolPermission(workspaceWrite, "browser_press"), "allow");
assert.equal(getToolPermission(workspaceWrite, "read_external_file"), "allow");
assert.equal(getToolPermission(workspaceWrite, "start_process"), "allow");
assert.equal(getToolPermission(workspaceWrite, "git_push"), "allow");
assert.equal(getToolPermission(workspaceWrite, "github_pr_create"), "allow");
assert.equal(getToolPermission(workspaceWrite, "read_process"), "allow");

const readOnly = createPermissionPolicy("read-only");
assert.equal(getToolPermission(readOnly, "read_external_file"), "allow");

const builderWrite = createPermissionPolicy("builder-write");
assert.equal(getToolPermission(builderWrite, "run_command"), "allow");
assert.equal(getToolPermission(builderWrite, "browser_click"), "deny");
assert.equal(getToolPermission(builderWrite, "delegate_subagent"), "deny");
assert.equal(getToolPermission(builderWrite, "read_external_file"), "deny");

const dockerAuto = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  executionMode: "isolated",
  input: { command: "npm test" },
  sandboxStatus: { available: true, autoApprovalSafe: true },
});
assert.equal(dockerAuto.denied, false);
assert.equal(dockerAuto.requiresApproval, false);
assert.equal(dockerAuto.autoApproved, true);
assert.equal(dockerAuto.executionMode, "isolated-auto-approval");

const externalRead = resolveToolExecutionPermission({
  toolName: "read_external_file",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  input: { path: "C:\\Users\\demo\\notes.md", reason: "Read the requested notes" },
});
assert.equal(externalRead.denied, false);
assert.equal(externalRead.requiresApproval, false);

const localAuto = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  executionMode: "safe",
  input: { command: "npm run build" },
  sandboxStatus: { available: false, localAvailable: true, autoApprovalSafe: true },
});
assert.equal(localAuto.requiresApproval, false);
assert.equal(localAuto.executionMode, "safe-auto-approval");

const dependencyMutation = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  executionMode: "safe",
  input: { command: "npm install lodash" },
  sandboxStatus: { localAvailable: true, autoApprovalSafe: true },
});
assert.equal(dependencyMutation.requiresApproval, false);
assert.equal(dependencyMutation.autoApproved, true);
assert.equal(dependencyMutation.commandPolicy.category, "dependency-mutation");

const networkRead = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  executionMode: "safe",
  input: { command: "curl https://example.com/schema.json" },
  sandboxStatus: { localAvailable: true, autoApprovalSafe: true },
});
assert.equal(networkRead.requiresApproval, false);
assert.equal(networkRead.commandPolicy.category, "network-read");

const devServer = resolveToolExecutionPermission({
  toolName: "start_process",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  executionMode: "safe",
  input: { command: "npm run dev" },
  sandboxStatus: { localAvailable: true, autoApprovalSafe: true },
});
assert.equal(devServer.requiresApproval, false);
assert.equal(devServer.autoApproved, true);
assert.equal(devServer.commandPolicy.category, "development-server");

const unknownPersistentProcess = resolveToolExecutionPermission({
  toolName: "start_process",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  executionMode: "safe",
  input: { command: "node scripts/custom-daemon.js" },
  sandboxStatus: { localAvailable: true, autoApprovalSafe: true },
});
assert.equal(unknownPersistentProcess.requiresApproval, true);
assert.equal(unknownPersistentProcess.commandPolicy.category, "host-authority-unknown");

const unknownLocalCommand = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  executionMode: "safe",
  input: { command: "node scripts/custom.js" },
  sandboxStatus: { localAvailable: true, autoApprovalSafe: true },
});
assert.equal(unknownLocalCommand.requiresApproval, true);
assert.equal(unknownLocalCommand.commandPolicy.category, "host-authority-unknown");

const directSafeCommand = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  executionMode: "direct",
  input: { command: "git status" },
});
assert.equal(directSafeCommand.requiresApproval, false);
assert.equal(directSafeCommand.executionMode, "direct-auto-approval");

const directUnknownCommand = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  executionMode: "direct",
  input: { command: "node scripts/custom.js" },
});
assert.equal(directUnknownCommand.requiresApproval, true);
assert.equal(directUnknownCommand.executionMode, "direct-manual-approval");

const featurePush = resolveToolExecutionPermission({
  toolName: "git_push",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  input: { remote: "origin", branch: "agent/fix-login" },
});
assert.equal(featurePush.requiresApproval, false);
assert.equal(featurePush.effectPolicy.category, "remote-reversible");

const protectedPush = resolveToolExecutionPermission({
  toolName: "git_push",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  input: { remote: "origin", branch: "main" },
});
assert.equal(protectedPush.requiresApproval, true);
assert.equal(protectedPush.effectPolicy.category, "protected-branch-write");

const ambiguousPush = resolveToolExecutionPermission({
  toolName: "git_push",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  input: { remote: "origin" },
});
assert.equal(ambiguousPush.requiresApproval, true);
assert.equal(ambiguousPush.effectPolicy.category, "remote-destination-ambiguous");

const destructivePatch = resolveToolExecutionPermission({
  toolName: "apply_patch",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  input: {
    patch: "diff --git a/src/old.js b/src/old.js\ndeleted file mode 100644\n--- a/src/old.js\n+++ /dev/null\n",
  },
});
assert.equal(destructivePatch.requiresApproval, true);
assert.equal(destructivePatch.effectPolicy.category, "destructive-workspace");

const explicitAskCannotBeBypassed = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "ask",
  approvalMode: "sandbox-auto",
  executionMode: "isolated",
  input: { command: "npm test" },
  sandboxStatus: { available: true },
});
assert.equal(explicitAskCannotBeBypassed.requiresApproval, true);
assert.equal(explicitAskCannotBeBypassed.autoApproved, false);

const criticalCommand = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  executionMode: "isolated",
  input: { command: "rm -rf /" },
  sandboxStatus: { available: true },
});
assert.equal(criticalCommand.denied, true);
assert.equal(criticalCommand.commandPolicy.risk, "critical");

const manualSandbox = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "allow",
  approvalMode: "manual",
  executionMode: "safe",
  input: { command: "npm test" },
  sandboxStatus: { localAvailable: true, autoApprovalSafe: true },
});
assert.equal(manualSandbox.requiresApproval, true);
assert.equal(manualSandbox.executionMode, "safe-manual-approval");

const browserControl = resolveToolExecutionPermission({
  toolName: "browser_click",
  permissionAction: "allow",
  approvalMode: "sandbox-auto",
  sandboxStatus: { localAvailable: true },
});
assert.equal(browserControl.requiresApproval, false);

const denied = resolveToolExecutionPermission({
  toolName: "run_command",
  permissionAction: "deny",
  approvalMode: "sandbox-auto",
  executionMode: "isolated",
  input: { command: "npm test" },
  sandboxStatus: { available: true },
});
assert.equal(denied.denied, true);
assert.equal(denied.requiresApproval, false);

const approvalRequest = buildToolApprovalRequest({
  toolName: "git_push",
  descriptor: { risk: "control" },
  input: { remote: "origin", branch: "main" },
  permissionDecision: protectedPush,
});
assert.equal(approvalRequest.riskLevel, "high");
assert.equal(approvalRequest.riskCategory, "protected-branch-write");
assert.match(approvalRequest.reason, /main/i);
assert.equal(approvalRequest.title, "推送 Git 分支");

const browserApproval = buildToolApprovalRequest({
  toolName: "browser_click",
  descriptor: { risk: "control" },
  input: { reason: "Open the next result" },
});
assert.equal(browserApproval.toolName, "browser_click");
assert.equal(browserApproval.kind, "control");

// Approval-card formatting is still supported for project policies that make
// external reads more restrictive than the Desktop default.
const externalApproval = buildToolApprovalRequest({
  toolName: "read_external_file",
  descriptor: { risk: "read" },
  input: { path: "C:\\Users\\demo\\notes.md", reason: "Read the requested notes" },
});
assert.equal(externalApproval.title, "读取工作区外文件");
assert.match(externalApproval.command, /notes\.md/);

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
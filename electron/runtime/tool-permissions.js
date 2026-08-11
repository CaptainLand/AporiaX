import {
  classifyCommandPermission,
  isAutomaticApprovalMode,
  normalizeExecutionMode,
  resolveExecutionBackend,
} from "./execution-policy.js";

export function resolveToolExecutionPermission({
  toolName,
  permissionAction,
  approvalMode = "manual",
  sandboxStatus = null,
  executionMode = null,
  input = {},
} = {}) {
  const mode = executionMode
    ? normalizeExecutionMode(executionMode)
    : sandboxStatus?.available
      ? "isolated"
      : "safe";
  const backend = resolveExecutionBackend({
    executionMode: mode,
    sandboxStatus,
  });
  const commandPolicy =
    toolName === "run_command"
      ? classifyCommandPermission(input?.command, { executionMode: mode })
      : null;
  const denied =
    permissionAction === "deny" || commandPolicy?.action === "deny";
  const explicitAsk = permissionAction === "ask";
  const automaticMode = isAutomaticApprovalMode(approvalMode);
  const commandPolicyAllowsAuto = commandPolicy?.action === "allow";
  const backendReady = backend.available;
  const autoApproved = Boolean(
    !denied &&
      !explicitAsk &&
      toolName === "run_command" &&
      automaticMode &&
      commandPolicyAllowsAuto &&
      backendReady,
  );
  const commandNeedsApproval = Boolean(
    toolName === "run_command" &&
      !denied &&
      (explicitAsk ||
        commandPolicy?.action === "ask" ||
        !automaticMode ||
        !backendReady),
  );
  const requiresApproval = Boolean(
    !denied &&
      (toolName === "run_command"
        ? commandNeedsApproval && !autoApproved
        : explicitAsk),
  );

  let resolvedExecutionMode = "direct";
  if (toolName === "run_command") {
    resolvedExecutionMode = autoApproved
      ? `${mode}-auto-approval`
      : requiresApproval
        ? `${mode}-manual-approval`
        : `${mode}-permitted`;
  } else if (requiresApproval) {
    resolvedExecutionMode = "manual-approval";
  }

  return Object.freeze({
    denied,
    requiresApproval,
    autoApproved,
    // Compatibility field for existing UI/runtime consumers. In v0.6.5 this
    // means policy-aware automatic approval, not merely "a sandbox exists".
    sandboxAutoApproved: autoApproved,
    sandboxSafe: backend.workspaceIsolation || backend.osIsolation,
    backend,
    commandPolicy,
    executionMode: resolvedExecutionMode,
  });
}

export function buildToolApprovalRequest({
  toolName,
  descriptor,
  input = {},
  sandboxStatus = null,
  permissionDecision = null,
} = {}) {
  const risk = descriptor?.risk || "control";
  const command =
    toolName === "run_command" || toolName === "start_process"
      ? String(input.command || "").trim()
      : `${toolName || "tool"}${input.path ? ` ${input.path}` : ""}`;
  const commandPolicy = permissionDecision?.commandPolicy || null;
  return {
    toolName: toolName || "unknown",
    kind: risk,
    title:
      toolName === "run_command"
        ? "运行工作区命令"
        : toolName === "start_process"
          ? "启动持久终端进程"
          : toolName === "read_external_file"
            ? "读取工作区外文件"
            : `允许工具：${toolName || "unknown"}`,
    command,
    cwd: input.cwd || ".",
    reason:
      typeof input.reason === "string" && input.reason.trim()
        ? input.reason.trim()
        : commandPolicy?.reason ||
          (risk === "read"
            ? "Agent 请求读取工作区信息。"
            : "Agent 请求执行可能改变工作区或运行进程的操作。"),
    ...(commandPolicy
      ? {
          riskLevel: commandPolicy.risk,
          riskCategory: commandPolicy.category,
        }
      : {}),
    ...(toolName === "run_command" ? { sandbox: sandboxStatus } : {}),
  };
}

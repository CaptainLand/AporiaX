export function resolveToolExecutionPermission({
  toolName,
  permissionAction,
  approvalMode = "manual",
  sandboxStatus = null,
} = {}) {
  const denied = permissionAction === "deny";
  const sandboxSafe = Boolean(
    sandboxStatus?.autoApprovalSafe ||
      sandboxStatus?.available ||
      sandboxStatus?.localAvailable,
  );
  const sandboxAutoApproved =
    !denied &&
    toolName === "run_command" &&
    approvalMode === "sandbox-auto" &&
    sandboxSafe;

  const requiresApproval =
    !denied &&
    ((permissionAction === "ask" && !sandboxAutoApproved) ||
      (toolName === "run_command" &&
        approvalMode === "manual" &&
        !sandboxAutoApproved));

  let executionMode = "direct";
  if (toolName === "run_command") {
    executionMode = sandboxAutoApproved
      ? sandboxStatus?.available
        ? "container-auto-approval"
        : "local-workspace-auto-approval"
      : requiresApproval
        ? sandboxSafe
          ? "sandbox-manual-approval"
          : "host-manual-approval"
        : sandboxSafe
          ? "sandbox-permitted"
          : "host-permitted";
  } else if (requiresApproval) {
    executionMode = "manual-approval";
  }

  return Object.freeze({
    denied,
    requiresApproval,
    sandboxAutoApproved,
    sandboxSafe,
    executionMode,
  });
}

export function buildToolApprovalRequest({
  toolName,
  descriptor,
  input = {},
  sandboxStatus = null,
} = {}) {
  const risk = descriptor?.risk || "control";
  const command =
    toolName === "run_command"
      ? String(input.command || "").trim()
      : `${toolName || "tool"}${input.path ? ` ${input.path}` : ""}`;
  return {
    kind: risk,
    title:
      toolName === "run_command"
        ? "运行工作区命令"
        : `允许工具：${toolName || "unknown"}`,
    command,
    cwd: input.cwd || ".",
    reason:
      typeof input.reason === "string" && input.reason.trim()
        ? input.reason.trim()
        : risk === "read"
          ? "Agent 请求读取工作区信息。"
          : "Agent 请求执行可能改变工作区或运行进程的操作。",
    ...(toolName === "run_command" ? { sandbox: sandboxStatus } : {}),
  };
}

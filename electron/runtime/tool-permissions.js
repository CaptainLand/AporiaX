import {
  classifyCommandPermission,
  isAutomaticApprovalMode,
  normalizeExecutionMode,
  resolveExecutionBackend,
} from "./execution-policy.js";

const COMMAND_TOOLS = new Set(["run_command", "start_process"]);
const PROTECTED_BRANCHES = new Set(["main", "master"]);

function permissionEffect(action, risk, category, reason) {
  return Object.freeze({ action, risk, category, reason });
}

function patchDeletesFiles(input = {}) {
  const patch = String(input?.patch || "");
  return /(?:^|\n)(?:deleted file mode\s+\d+|\+\+\+\s+\/dev\/null(?:\r?\n|$))/m.test(
    patch,
  );
}

function classifyToolEffectPermission(toolName, input = {}) {
  if (toolName === "apply_patch" && patchDeletesFiles(input)) {
    return permissionEffect(
      "ask",
      "high",
      "destructive-workspace",
      "The patch deletes one or more workspace files and requires explicit confirmation.",
    );
  }

  if (toolName === "git_push") {
    const branch = String(input?.branch || "").trim();
    if (!branch) {
      return permissionEffect(
        "ask",
        "medium",
        "remote-destination-ambiguous",
        "Automatic push requires an explicit non-protected branch so the Harness can verify the remote effect.",
      );
    }
    const normalizedBranch = branch
      .replace(/^refs\/heads\//i, "")
      .replace(/^HEAD:/i, "")
      .trim()
      .toLowerCase();
    if (PROTECTED_BRANCHES.has(normalizedBranch)) {
      return permissionEffect(
        "ask",
        "high",
        "protected-branch-write",
        `Pushing directly to ${normalizedBranch} changes a protected delivery branch.`,
      );
    }
    return permissionEffect(
      "allow",
      "medium",
      "remote-reversible",
      "The push targets an explicit non-protected branch and force push is unsupported by the native tool.",
    );
  }

  return null;
}

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
    : sandboxStatus?.executionProfile
      ? normalizeExecutionMode(sandboxStatus.executionProfile)
      : sandboxStatus?.available
        ? "isolated"
        : "safe";
  const backend = resolveExecutionBackend({
    executionMode: mode,
    sandboxStatus,
  });
  const commandTool = COMMAND_TOOLS.has(toolName);
  const commandPolicy = commandTool
    ? classifyCommandPermission(input?.command, { executionMode: mode })
    : null;
  const effectPolicy = classifyToolEffectPermission(toolName, input);
  const denied =
    permissionAction === "deny" ||
    commandPolicy?.action === "deny" ||
    effectPolicy?.action === "deny";
  const explicitAsk = permissionAction === "ask";
  const automaticMode = isAutomaticApprovalMode(approvalMode);
  const commandPolicyAllowsAuto = commandPolicy?.action === "allow";
  const backendReady = backend.available;
  const autoApproved = Boolean(
    !denied &&
      !explicitAsk &&
      commandTool &&
      automaticMode &&
      commandPolicyAllowsAuto &&
      effectPolicy?.action !== "ask" &&
      backendReady,
  );
  const commandNeedsApproval = Boolean(
    commandTool &&
      !denied &&
      (explicitAsk ||
        commandPolicy?.action === "ask" ||
        effectPolicy?.action === "ask" ||
        !automaticMode ||
        !backendReady),
  );
  const requiresApproval = Boolean(
    !denied &&
      (commandTool
        ? commandNeedsApproval && !autoApproved
        : explicitAsk || effectPolicy?.action === "ask"),
  );

  let resolvedExecutionMode = "direct";
  if (commandTool) {
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
    effectPolicy,
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
  const effectPolicy = permissionDecision?.effectPolicy || null;
  const approvalTitles = {
    lsp_install: "安装语言服务器",
    git_init: "初始化 Git 仓库",
    git_stage: "暂存 Git 变更",
    git_commit: "创建 Git Commit",
    git_create_branch: "创建 Git 分支",
    git_remote_add: "添加 Git 远程仓库",
    git_pull: "拉取远程 Git 变更",
    git_push: "推送 Git 分支",
    github_repo_create: "创建 GitHub 仓库",
    github_pr_create: "创建 GitHub Pull Request",
    apply_patch: "删除工作区文件",
  };
  const policy = effectPolicy || commandPolicy;
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
            : approvalTitles[toolName] || `允许工具：${toolName || "unknown"}`,
    command,
    cwd: input.cwd || ".",
    reason:
      typeof input.reason === "string" && input.reason.trim()
        ? input.reason.trim()
        : policy?.reason ||
          (risk === "read"
            ? "Agent 请求读取工作区信息。"
            : "Agent 请求执行可能改变工作区或运行进程的操作。"),
    ...(policy
      ? {
          riskLevel: policy.risk,
          riskCategory: policy.category,
        }
      : {}),
    ...(commandToolApprovalSandbox(toolName) ? { sandbox: sandboxStatus } : {}),
  };
}

function commandToolApprovalSandbox(toolName) {
  return COMMAND_TOOLS.has(toolName);
}

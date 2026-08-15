export const EXECUTION_MODES = Object.freeze(["direct", "safe", "isolated"]);

const AUTO_APPROVAL_MODES = new Set(["sandbox-auto", "smart-auto"]);

const SHELL_COMPOSITION = /(?:&&|\|\||[;&|><`\r\n]|\$\()/;
const PROTECTED_BRANCHES = new Set(["main", "master"]);

function commandDecision(action, risk, category, reason, executionMode) {
  return Object.freeze({ action, risk, category, reason, executionMode });
}

function normalizeGitRefName(value) {
  return String(value || "")
    .replace(/^refs\/heads\//i, "")
    .replace(/^HEAD:/i, "")
    .trim()
    .toLowerCase();
}

function classifyGitPushCommand(command, executionMode) {
  const source = String(command || "").trim();
  if (!/^git\s+push\b/i.test(source)) return null;
  if (SHELL_COMPOSITION.test(source)) {
    return commandDecision(
      "ask",
      "high",
      "remote-write-composed",
      "Composed remote-write commands require approval because their full side effects cannot be bounded safely.",
      executionMode,
    );
  }
  if (/\b(?:--force-with-lease|--force|-f)\b/i.test(source)) {
    return commandDecision(
      "ask",
      "high",
      "remote-destructive",
      "Force push can rewrite shared remote history.",
      executionMode,
    );
  }
  if (/\b(?:--delete|-d)\b/i.test(source)) {
    return commandDecision(
      "ask",
      "high",
      "remote-destructive",
      "Deleting a remote branch requires explicit confirmation.",
      executionMode,
    );
  }

  const match = source.match(
    /^git\s+push\s+(?:(?:-u|--set-upstream)\s+)?([^\s]+)\s+([^\s]+)\s*$/i,
  );
  if (!match) {
    return commandDecision(
      "ask",
      "medium",
      "remote-destination-ambiguous",
      "Automatic push requires an explicit remote and non-protected branch.",
      executionMode,
    );
  }
  const target = normalizeGitRefName(match[2]);
  if (!target || target.startsWith(":")) {
    return commandDecision(
      "ask",
      "high",
      "remote-destructive",
      "The push target may delete or rewrite remote state.",
      executionMode,
    );
  }
  if (PROTECTED_BRANCHES.has(target)) {
    return commandDecision(
      "ask",
      "high",
      "protected-branch-write",
      `Pushing directly to ${target} requires explicit confirmation.`,
      executionMode,
    );
  }
  return commandDecision(
    "allow",
    "medium",
    "remote-reversible",
    "The push targets an explicit non-protected branch without force.",
    executionMode,
  );
}

const RULES = Object.freeze([
  {
    action: "deny",
    risk: "critical",
    category: "system-destructive",
    reason: "The command can destructively target the host system or storage.",
    patterns: [
      /(?:^|[;&|]\s*)rm\s+-[^\n]*r[^\n]*f[^\n]*(?:\/|~|\$HOME)(?:\s|$)/i,
      /(?:^|[;&|]\s*)(?:mkfs(?:\.[\w-]+)?|format)(?:\s|$)/i,
      /(?:^|[;&|]\s*)(?:shutdown|reboot|poweroff)(?:\s|$)/i,
      /(?:^|[;&|]\s*)(?:diskpart|bcdedit)(?:\s|$)/i,
    ],
  },
  {
    action: "ask",
    risk: "high",
    category: "remote-destructive",
    reason: "The command can irreversibly rewrite, delete, publish, deploy, or finalize remote state.",
    patterns: [
      /\bgh\s+pr\s+(?:merge|close)\b/i,
      /\bgh\s+release\s+(?:create|delete|edit)\b/i,
      /\b(?:npm|pnpm|yarn|bun)\s+(?:publish|deploy)\b/i,
      /\bdocker\s+push\b/i,
    ],
  },
  {
    action: "ask",
    risk: "high",
    category: "destructive-workspace",
    reason: "The command can discard, delete, or rewrite workspace state.",
    patterns: [
      /\bgit\s+reset\s+--hard\b/i,
      /\bgit\s+clean\s+[^\n]*(?:-[^\s]*f|--force)\b/i,
      /\bgit\s+branch\s+-D\b/,
      /\bgit\s+(?:checkout|restore)\s+--?\s*\.?\s*$/im,
      /(?:^|[;&|]\s*)rm\s+-[^\n]*r[^\n]*f\b/i,
      /(?:^|[;&|]\s*)(?:rmdir|rd)\s+\/s\b/i,
      /(?:^|[;&|]\s*)del\s+[^\n]*\/s\b/i,
      /\bRemove-Item\b[^\n]*(?:-Recurse|-Force)/i,
    ],
  },
  {
    action: "ask",
    risk: "high",
    category: "network-sensitive",
    reason: "The command may transmit credentials or authenticated local state to an external endpoint.",
    patterns: [
      /(?:^|[;&|]\s*)(?:curl|wget)\b[^\n]*(?:Authorization|Bearer\s+|Cookie:|--cookie\b|--user\b|\s-u\s|--cert\b|--key\b)/i,
      /\bInvoke-(?:WebRequest|RestMethod)\b[^\n]*(?:Authorization|Bearer\s+|Cookie)/i,
    ],
  },
  {
    action: "ask",
    risk: "high",
    category: "network-write",
    reason: "The command can upload local data or mutate external state.",
    patterns: [
      /(?:^|[;&|]\s*)curl\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE)|--data(?:-raw|-binary|-urlencode)?\b|-d\b|--form\b|-F\b|--upload-file\b|-T\b)/i,
      /(?:^|[;&|]\s*)wget\b[^\n]*(?:--post-data|--post-file)/i,
      /\bInvoke-RestMethod\b[^\n]*-(?:Method|Body|InFile)\b/i,
      /\bInvoke-WebRequest\b[^\n]*-(?:Method|Body|InFile)\b/i,
    ],
  },
  {
    action: "allow",
    risk: "medium",
    category: "dependency-mutation",
    reason: "Dependency changes are workspace-scoped, reversible through manifests/lockfiles, and verifiable by the Harness.",
    patterns: [
      /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add|remove|uninstall|update|upgrade)(?:\s|$)/i,
      /\b(?:pip|pip3)\s+(?:install|uninstall)(?:\s|$)/i,
      /\bpython(?:3)?\s+-m\s+pip\s+(?:install|uninstall)(?:\s|$)/i,
      /\bcargo\s+(?:add|remove|install|uninstall|update)(?:\s|$)/i,
      /\bgo\s+get(?:\s|$)/i,
    ],
  },
  {
    action: "allow",
    risk: "low",
    category: "development-server",
    reason: "The command starts a conventional workspace development server or preview process managed by the task runtime.",
    patterns: [
      /^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)(?:\s|$)/i,
      /^\s*(?:npx\s+)?(?:vite|next\s+dev)(?:\s|$)/i,
      /^\s*python(?:3)?\s+-m\s+http\.server(?:\s|$)/i,
      /^\s*(?:python(?:3)?\s+-m\s+)?uvicorn(?:\s|$)/i,
      /^\s*(?:python(?:3)?\s+-m\s+)?flask\s+run(?:\s|$)/i,
    ],
  },
  {
    action: "allow",
    risk: "medium",
    category: "network-read",
    reason: "The command performs an unauthenticated read-only network fetch and does not intentionally mutate remote state.",
    patterns: [
      /(?:^|[;&|]\s*)curl\b/i,
      /(?:^|[;&|]\s*)wget\b/i,
      /\bInvoke-WebRequest\b/i,
      /\bInvoke-RestMethod\b/i,
    ],
  },
  {
    action: "allow",
    risk: "medium",
    category: "remote-reversible",
    reason: "Creating a pull request is a reversible review artifact and may run autonomously.",
    patterns: [/^\s*gh\s+pr\s+create\b/i],
  },
  {
    action: "allow",
    risk: "low",
    category: "git-read",
    reason: "The command only inspects Git state or history.",
    patterns: [
      /^\s*git\s+(?:status|diff|log|show)(?:\s|$)/i,
      /^\s*git\s+branch\s+--show-current\s*$/i,
    ],
  },
  {
    action: "allow",
    risk: "low",
    category: "verification",
    reason: "The command matches a bounded build, test, lint, type-check, or read-only runtime inspection workflow.",
    patterns: [
      /^\s*(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|lint|typecheck|check))(?:\s|$)/i,
      /^\s*npx\s+tsc\b[^\n]*--noEmit\b/i,
      /^\s*(?:pytest|python(?:3)?\s+-m\s+pytest)(?:\s|$)/i,
      /^\s*go\s+test(?:\s|$)/i,
      /^\s*cargo\s+(?:test|check)(?:\s|$)/i,
      /^\s*node\s+--check(?:\s|$)/i,
      /^\s*node\s+(?:--version|-v)\s*$/i,
    ],
  },
]);

export function normalizeExecutionMode(value, fallback = "safe") {
  return EXECUTION_MODES.includes(value) ? value : fallback;
}

export function isAutomaticApprovalMode(value) {
  return AUTO_APPROVAL_MODES.has(value);
}

export function resolveExecutionBackend({ executionMode = "safe", sandboxStatus = null } = {}) {
  const mode = normalizeExecutionMode(executionMode);
  if (mode === "direct") {
    return Object.freeze({
      mode,
      backend: "host",
      available: true,
      osIsolation: false,
      workspaceIsolation: false,
      networkIsolation: false,
    });
  }
  if (mode === "safe") {
    return Object.freeze({
      mode,
      backend: "local-workspace",
      available: Boolean(
        sandboxStatus?.localAvailable ?? sandboxStatus?.autoApprovalSafe ?? true,
      ),
      osIsolation: false,
      workspaceIsolation: true,
      networkIsolation: false,
    });
  }
  return Object.freeze({
    mode,
    backend: "docker",
    available: Boolean(sandboxStatus?.available),
    osIsolation: true,
    workspaceIsolation: true,
    networkIsolation: true,
  });
}

export function classifyCommandPermission(command, { executionMode = "safe" } = {}) {
  const normalizedCommand = String(command || "").trim();
  const mode = normalizeExecutionMode(executionMode);
  if (!normalizedCommand) {
    return commandDecision(
      "ask",
      "medium",
      "unknown",
      "A concrete command is required before automatic approval can be evaluated.",
      mode,
    );
  }

  const gitPushDecision = classifyGitPushCommand(normalizedCommand, mode);
  if (gitPushDecision) return gitPushDecision;

  const composed = SHELL_COMPOSITION.test(normalizedCommand);
  for (const rule of RULES) {
    if (rule.action === "allow" && composed) continue;
    if (rule.patterns.some((pattern) => pattern.test(normalizedCommand))) {
      return commandDecision(
        rule.action,
        rule.risk,
        rule.category,
        rule.reason,
        mode,
      );
    }
  }

  if (mode === "isolated") {
    return commandDecision(
      "allow",
      "medium",
      "isolated-default",
      "Unknown commands may auto-run only inside the OS-level isolated execution profile.",
      mode,
    );
  }

  return commandDecision(
    "ask",
    "medium",
    mode === "direct" ? "direct-unknown" : "host-authority-unknown",
    mode === "direct"
      ? "Unknown host commands require approval because they run in the real workspace with host authority."
      : "Unknown commands require approval because the workspace-copy profile still uses host process and network authority.",
    mode,
  );
}

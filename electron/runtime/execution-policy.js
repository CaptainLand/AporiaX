export const EXECUTION_MODES = Object.freeze(["direct", "safe", "isolated"]);

const AUTO_APPROVAL_MODES = new Set(["sandbox-auto", "smart-auto"]);

const SHELL_COMPOSITION = /(?:&&|\|\||[;&|><`\r\n]|\$\()/;

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
    category: "remote-write",
    reason: "The command writes to a remote service or publishes external state.",
    patterns: [
      /\bgit\s+push\b/i,
      /\bgh\s+pr\s+(?:create|merge|close|reopen)\b/i,
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
    risk: "medium",
    category: "dependency-mutation",
    reason: "The command installs, removes, or upgrades executable dependencies.",
    patterns: [
      /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add|remove|uninstall|update|upgrade)\b/i,
      /\b(?:pip|pip3)\s+(?:install|uninstall)\b/i,
      /\bpython(?:3)?\s+-m\s+pip\s+(?:install|uninstall)\b/i,
      /\bcargo\s+(?:add|remove|install|uninstall|update)\b/i,
      /\bgo\s+get\b/i,
    ],
  },
  {
    action: "ask",
    risk: "medium",
    category: "network-transfer",
    reason: "The command performs an explicit network transfer outside AporiaX provider traffic.",
    patterns: [
      /(?:^|[;&|]\s*)(?:curl|wget)(?:\s|$)/i,
      /\b(?:Invoke-WebRequest|Invoke-RestMethod)\b/i,
    ],
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
    reason: "The command matches a bounded build, test, lint, or type-check workflow.",
    patterns: [
      /^\s*(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|lint|typecheck|check))(?:\s|$)/i,
      /^\s*npx\s+tsc\b[^\n]*--noEmit\b/i,
      /^\s*(?:pytest|python(?:3)?\s+-m\s+pytest)(?:\s|$)/i,
      /^\s*go\s+test(?:\s|$)/i,
      /^\s*cargo\s+(?:test|check)(?:\s|$)/i,
      /^\s*node\s+--check(?:\s|$)/i,
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
    return Object.freeze({
      action: "ask",
      risk: "medium",
      category: "unknown",
      reason: "A concrete command is required before automatic approval can be evaluated.",
      executionMode: mode,
    });
  }

  const composed = SHELL_COMPOSITION.test(normalizedCommand);
  for (const rule of RULES) {
    if (rule.action === "allow" && composed) continue;
    if (rule.patterns.some((pattern) => pattern.test(normalizedCommand))) {
      return Object.freeze({
        action: rule.action,
        risk: rule.risk,
        category: rule.category,
        reason: rule.reason,
        executionMode: mode,
      });
    }
  }

  if (mode === "isolated") {
    return Object.freeze({
      action: "allow",
      risk: "medium",
      category: "isolated-default",
      reason: "Unknown commands may auto-run only inside the OS-level isolated execution profile.",
      executionMode: mode,
    });
  }

  return Object.freeze({
    action: "ask",
    risk: "medium",
    category: mode === "direct" ? "direct-unknown" : "host-authority-unknown",
    reason:
      mode === "direct"
        ? "Unknown host commands require approval because they run in the real workspace with host authority."
        : "Unknown commands require approval because the workspace-copy profile still uses host process and network authority.",
    executionMode: mode,
  });
}

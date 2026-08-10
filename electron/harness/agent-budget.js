import { AsyncLocalStorage } from "node:async_hooks";

const budgetStorage = new AsyncLocalStorage();
const PROFILE_ORDER = ["direct", "read", "light", "standard", "large"];
const PROFILE_LIMITS = Object.freeze({
  direct: Object.freeze({
    maxTotalSubagents: 0,
    maxActiveSubagents: 0,
    roles: Object.freeze({ explore: 0, review: 0, verify: 0, curator: 0, builder: 0, other: 0 }),
  }),
  read: Object.freeze({
    maxTotalSubagents: 1,
    maxActiveSubagents: 1,
    roles: Object.freeze({ explore: 1, review: 0, verify: 0, curator: 0, builder: 0, other: 0 }),
  }),
  light: Object.freeze({
    maxTotalSubagents: 1,
    maxActiveSubagents: 1,
    roles: Object.freeze({ explore: 1, review: 1, verify: 1, curator: 0, builder: 0, other: 0 }),
  }),
  standard: Object.freeze({
    maxTotalSubagents: 4,
    maxActiveSubagents: 2,
    roles: Object.freeze({ explore: 1, review: 2, verify: 1, curator: 1, builder: 0, other: 1 }),
  }),
  large: Object.freeze({
    maxTotalSubagents: 7,
    maxActiveSubagents: 4,
    roles: Object.freeze({ explore: 2, review: 2, verify: 1, curator: 1, builder: 2, other: 2 }),
  }),
});

const MUTATION_PATTERN = /(?:\b(?:add|build|create|edit|fix|implement|migrate|modify|refactor|replace|rewrite|upgrade|write)\b|新增|增加|实现|开发|修改|改造|修复|重构|迁移|替换|升级|写入|制作|接入)/i;
const INVESTIGATION_PATTERN = /(?:\b(?:analy[sz]e|debug|explain|explore|exploration|find|inspect|investigate|review|search|trace|understand)\b|分析|解释|探索|查找|检查|排查|调试|搜索|理解|看看|研究)/i;
const LARGE_PATTERN = /(?:\b(?:architecture|cross[- ]module|end[- ]to[- ]end|multi[- ]module|platform|plugin|runtime|server|migration|worktree|scheduler)\b|架构|跨模块|全链路|多模块|平台|插件|运行时|服务端|调度|工作树|大规模|整体重构)/i;
const SIMPLE_PATTERN = /(?:\b(?:tiny|trivial|quick|one[- ]file|rename|typo)\b|简单|小改|只改|改个|单文件|文案|重命名|错别字)/i;
const AGENT_PATTERN = /(?:\b(?:agent|subagent|parallel|builder|worker)\b|子 ?agent|多 ?agent|并行|builder|worker)/i;
const VERIFICATION_PATTERN = /(?:\b(?:build|lint|test|typecheck|verify)\b|构建|测试|验证|检查)/i;
const PATH_PATTERN = /(?:^|\s|[`'"(])(?:\.?\.?\/)?[\w@.-]+(?:\/[\w@.()\[\]-]+)+(?:\.[a-z0-9]{1,12})?/gi;

function requestText(options = {}) {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const latestUser = [...messages]
    .reverse()
    .find((message) => message?.role === "user" && typeof message?.content === "string");
  return String(latestUser?.content || options.prompt || "").trim();
}

function hasWritePermission(options = {}) {
  return String(options.permission || "").toLowerCase() === "workspace-write";
}

function mergeLimits(base, override = {}) {
  const roleOverride = override?.roles && typeof override.roles === "object" ? override.roles : {};
  const roleLimits = { ...base.roles };
  for (const [role, value] of Object.entries(roleOverride)) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) roleLimits[role] = Math.floor(number);
  }
  const total = Number(override.maxTotalSubagents);
  const active = Number(override.maxActiveSubagents);
  return Object.freeze({
    maxTotalSubagents:
      Number.isFinite(total) && total >= 0 ? Math.floor(total) : base.maxTotalSubagents,
    maxActiveSubagents:
      Number.isFinite(active) && active >= 0 ? Math.floor(active) : base.maxActiveSubagents,
    roles: Object.freeze(roleLimits),
  });
}

function profileAtLeast(left, right) {
  return PROFILE_ORDER.indexOf(left) >= PROFILE_ORDER.indexOf(right);
}

function classifyRequest(options = {}) {
  const text = requestText(options);
  const hasWorkspace = typeof options.workspacePath === "string" && Boolean(options.workspacePath.trim());
  const writable = hasWritePermission(options);
  const mutating = MUTATION_PATTERN.test(text);
  const investigating = INVESTIGATION_PATTERN.test(text);
  const explicitLarge = LARGE_PATTERN.test(text);
  const explicitSimple = SIMPLE_PATTERN.test(text);
  const mentionsAgents = AGENT_PATTERN.test(text);
  const needsVerification = VERIFICATION_PATTERN.test(text);
  const pathMentions = new Set(text.match(PATH_PATTERN) || []).size;

  if (!hasWorkspace) {
    return { profile: "direct", score: 0, reason: "no-workspace", text };
  }
  if (!mutating) {
    if (investigating && (text.length > 220 || pathMentions > 0 || mentionsAgents)) {
      return { profile: "read", score: 1, reason: "workspace-investigation", text };
    }
    return { profile: "direct", score: 0, reason: "simple-question", text };
  }
  if (!writable) {
    return { profile: "read", score: 1, reason: "write-not-authorized", text };
  }

  let score = 2;
  if (text.length > 700) score += 1;
  if (text.length > 1_800) score += 1;
  if (pathMentions >= 2) score += 1;
  if (pathMentions >= 4) score += 1;
  if (needsVerification) score += 1;
  if (mentionsAgents) score += 1;
  if (explicitLarge) score += 2;
  if (explicitSimple) score -= 2;

  if (score <= 2) return { profile: "light", score, reason: "small-write", text };
  if (score <= 5) return { profile: "standard", score, reason: "multi-step-write", text };
  return { profile: "large", score, reason: "large-parallel-write", text };
}

export function planAgentBudget(options = {}) {
  const classified = classifyRequest(options);
  const requestedProfile = String(options?.agentBudget?.profile || "").toLowerCase();
  const profile = PROFILE_LIMITS[requestedProfile] ? requestedProfile : classified.profile;
  const limits = mergeLimits(PROFILE_LIMITS[profile], options?.agentBudget || {});
  const locked = Boolean(options?.agentBudget?.locked);
  return Object.freeze({
    version: 1,
    profile,
    locked,
    reason: requestedProfile ? "explicit-override" : classified.reason,
    score: classified.score,
    limits,
    requestPreview: classified.text.replace(/\s+/g, " ").slice(0, 240),
  });
}

function publicPlan(context) {
  if (!context) return null;
  return {
    ...context.plan,
    profile: context.profile,
    locked: context.locked,
    limits: context.limits,
    state: {
      totalStarted: context.state.totalStarted,
      active: context.state.activeIds.size,
      byRole: { ...context.state.byRole },
      changedFiles: context.state.changedFiles.size,
      planSteps: context.state.planSteps,
    },
  };
}

function notify(context, event) {
  try {
    context?.onEvent?.(event);
  } catch {
    // Budget telemetry must never break a run.
  }
}

function elevate(context, nextProfile, reason) {
  if (context.locked) return false;
  if (!PROFILE_LIMITS[nextProfile] || profileAtLeast(context.profile, nextProfile)) return false;
  context.profile = nextProfile;
  context.limits = PROFILE_LIMITS[nextProfile];
  notify(context, {
    type: "agent_budget.escalated",
    profile: nextProfile,
    reason,
    limits: context.limits,
  });
  return true;
}

function roleBucket(role) {
  const value = String(role || "").toLowerCase();
  return Object.hasOwn(PROFILE_LIMITS.large.roles, value) ? value : "other";
}

function budgetError(message, detail) {
  const error = new Error(message);
  error.code = "APORIAX_AGENT_BUDGET";
  error.detail = detail;
  return error;
}

export function enforceAgentBudgetEvent(event) {
  const context = budgetStorage.getStore();
  if (!context || !event || typeof event.type !== "string") return;

  if (event.type === "plan.updated") {
    const steps = Array.isArray(event.plan?.steps) ? event.plan.steps.length : 0;
    context.state.planSteps = Math.max(context.state.planSteps, steps);
    if (steps >= 7) elevate(context, "large", "plan-has-seven-or-more-steps");
    else if (steps >= 3) elevate(context, "standard", "plan-has-three-or-more-steps");
    return;
  }

  if (event.type === "file.changed" && event.path) {
    context.state.changedFiles.add(String(event.path));
    const changed = context.state.changedFiles.size;
    if (changed >= 8) elevate(context, "large", "eight-or-more-files-changed");
    else if (changed >= 3) elevate(context, "standard", "three-or-more-files-changed");
    return;
  }

  if (event.type === "subagent.started") {
    const agentId = String(event.agentId || `anonymous-${context.state.totalStarted + 1}`);
    if (context.state.activeIds.has(agentId)) return;
    const role = roleBucket(event.role);
    const roleCount = context.state.byRole[role] || 0;
    const roleLimit = context.limits.roles[role] ?? context.limits.roles.other ?? 0;
    const detail = {
      agentId,
      role: event.role || role,
      profile: context.profile,
      totalStarted: context.state.totalStarted,
      maxTotalSubagents: context.limits.maxTotalSubagents,
      active: context.state.activeIds.size,
      maxActiveSubagents: context.limits.maxActiveSubagents,
      roleStarted: roleCount,
      roleLimit,
    };
    if (
      context.state.totalStarted >= context.limits.maxTotalSubagents ||
      context.state.activeIds.size >= context.limits.maxActiveSubagents ||
      roleCount >= roleLimit
    ) {
      notify(context, { type: "agent_budget.denied", ...detail });
      throw budgetError(
        `Agent delegation blocked by the ${context.profile} task budget (${event.role || role}).`,
        detail,
      );
    }
    context.state.totalStarted += 1;
    context.state.byRole[role] = roleCount + 1;
    context.state.activeIds.add(agentId);
    notify(context, {
      type: "agent_budget.consumed",
      agentId,
      role: event.role || role,
      profile: context.profile,
      remaining: Math.max(0, context.limits.maxTotalSubagents - context.state.totalStarted),
    });
    return;
  }

  if (["subagent.completed", "subagent.failed"].includes(event.type) && event.agentId) {
    context.state.activeIds.delete(String(event.agentId));
  }
}

export function agentBudgetAllowsTool(toolName) {
  const context = budgetStorage.getStore();
  if (!context) return true;
  if (toolName !== "delegate_subagent") return true;
  return context.limits.maxTotalSubagents > 0;
}

export function currentAgentBudget() {
  return publicPlan(budgetStorage.getStore());
}

export function runWithAgentBudget(plan, { onEvent = null } = {}, fn) {
  if (typeof fn !== "function") throw new Error("runWithAgentBudget requires a function.");
  const normalized = plan?.limits ? plan : planAgentBudget({});
  const context = {
    plan: normalized,
    profile: normalized.profile,
    locked: Boolean(normalized.locked),
    limits: normalized.limits,
    onEvent,
    state: {
      totalStarted: 0,
      activeIds: new Set(),
      byRole: {},
      changedFiles: new Set(),
      planSteps: 0,
    },
  };
  notify(context, {
    type: "agent_budget.planned",
    profile: context.profile,
    locked: context.locked,
    reason: normalized.reason,
    score: normalized.score,
    limits: context.limits,
  });
  return budgetStorage.run(context, fn);
}

export function profileLimits(profile) {
  return PROFILE_LIMITS[String(profile || "").toLowerCase()] || PROFILE_LIMITS.direct;
}

export { classifyRequest as classifyAgentTask };
import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeBuilderCount } from "./builder-count.js";

const budgetStorage = new AsyncLocalStorage();
const EXECUTION_MODES = new Set(["direct", "safe", "isolated"]);
const normalizeExecutionMode = (value, fallback = "safe") =>
  EXECUTION_MODES.has(value) ? value : fallback;
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

const MUTATION_PATTERN = /(?:\b(?:add|build|create|edit|fix|implement|migrate|modify|refactor|replace|rewrite|upgrade|write)\b|新增|增加|实现|开发|修改|改造|修复|重构|迁移|替换|升级|写入|制作|接入|创建)/i;
const INVESTIGATION_PATTERN = /(?:\b(?:analy[sz]e|debug|explain|explore|exploration|find|inspect|investigate|review|search|trace|understand)\b|分析|解释|探索|查找|检查|排查|调试|搜索|理解|看看|研究)/i;
const EXPLICIT_DELEGATION_PATTERN = /(?:\b(?:delegate|delegation|subagent)\b|\bin\s+the\s+background\b|委派|交给子 ?agent|调用子 ?agent|后台(?:探索|调查|检查|运行|执行))/i;
const EXPLICIT_EXPLORATION_PATTERN = /(?:\b(?:explore|exploration)\b|探索)/i;
const DURABLE_MEMORY_PATTERN = /(?:\b(?:remember|memorize)\b|记住|记忆(?:这个|此|该)?(?:偏好|约定|决定|规则|信息)?)/i;
const LARGE_PATTERN = /(?:\b(?:architecture|cross[- ]module|end[- ]to[- ]end|multi[- ]module|platform|plugin|runtime|server|migration|worktree|scheduler)\b|架构|跨模块|全链路|多模块|平台|插件|运行时|服务端|调度|工作树|大规模|整体重构)/i;
const SIMPLE_PATTERN = /(?:\b(?:tiny|trivial|quick|one[- ]file|rename|typo)\b|简单|小改|只改|改个|单文件|文案|重命名|错别字)/i;
const AGENT_PATTERN = /(?:\b(?:agent|subagent|parallel|builder|worker)\b|子 ?agent|多 ?agent|并行|builder|worker)/i;
const VERIFICATION_PATTERN = /(?:\b(?:build|lint|test|typecheck|verify|self[- ]?check)\b|构建|测试|验证|检查|自检|复核|校验)/i;
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
  const explicitDelegation = EXPLICIT_DELEGATION_PATTERN.test(text);
  const explicitExploration = EXPLICIT_EXPLORATION_PATTERN.test(text);
  const durableMemory = DURABLE_MEMORY_PATTERN.test(text);
  const explicitLarge = LARGE_PATTERN.test(text);
  const explicitSimple = SIMPLE_PATTERN.test(text);
  const mentionsAgents = AGENT_PATTERN.test(text);
  const needsVerification = VERIFICATION_PATTERN.test(text);
  const pathMentions = new Set(text.match(PATH_PATTERN) || []).size;

  if (!hasWorkspace) {
    return { profile: "direct", score: 0, reason: "no-workspace", text };
  }
  if (durableMemory) {
    return {
      profile: "standard",
      score: 3,
      reason: "durable-understanding",
      text,
    };
  }
  if (!mutating) {
    if (
      investigating &&
      (text.length > 220 ||
        pathMentions > 0 ||
        explicitDelegation ||
        explicitExploration ||
        mentionsAgents)
    ) {
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
  const builderCount = normalizeBuilderCount(options.builderLimit);
  const requestedBudget = { ...(options?.agentBudget || {}) };
  if (builderCount != null) {
    const extra = Math.max(0, builderCount - PROFILE_LIMITS[profile].roles.builder);
    requestedBudget.roles = { ...requestedBudget.roles, builder: requestedBudget.roles?.builder ?? builderCount };
    if (requestedBudget.maxTotalSubagents == null) {
      requestedBudget.maxTotalSubagents = PROFILE_LIMITS[profile].maxTotalSubagents + extra;
    }
    if (requestedBudget.maxActiveSubagents == null) {
      requestedBudget.maxActiveSubagents = PROFILE_LIMITS[profile].maxActiveSubagents + extra;
    }
  }
  const limits = mergeLimits(PROFILE_LIMITS[profile], requestedBudget);
  const executionMode = normalizeExecutionMode(options?.executionMode);
  return Object.freeze({
    version: 1,
    profile,
    executionMode,
    reason: requestedProfile ? "explicit-override" : classified.reason,
    score: classified.score,
    limits,
    // A UI Builder limit controls simultaneous work, not lifetime starts.
    builderConcurrency: builderCount,
    renewableBuilders: builderCount != null && options.agentBudget?.maxTotalSubagents == null && options.agentBudget?.roles?.builder == null,
    hardLimits: Object.freeze({
      ...Object.fromEntries(["maxTotalSubagents", "maxActiveSubagents"].filter((key) =>
        options.agentBudget?.[key] != null && Number.isFinite(Number(options.agentBudget[key])) && Number(options.agentBudget[key]) >= 0
      ).map((key) => [key, Math.floor(Number(options.agentBudget[key]))])),
      roles: Object.freeze({ ...(options.agentBudget?.roles || {}), ...(builderCount === 0 ? { builder: 0 } : {}) }),
    }),
    requestPreview: classified.text.replace(/\s+/g, " ").slice(0, 240),
    mayDelegate: Boolean(options.workspacePath),
  });
}

function publicPlan(context) {
  if (!context) return null;
  return {
    ...context.plan,
    profile: context.profile,
    executionMode: context.executionMode,
    limits: context.limits,
    state: {
      totalStarted: context.state.totalStarted,
      active: context.state.activeIds.size,
      byRole: { ...context.state.byRole },
      startedIds: [...context.state.startedIds],
      changedFiles: context.state.changedFiles.size,
      planSteps: context.state.planSteps,
      runningBuilders: [...context.state.activeRoles.values()].filter((role) => role === "builder").length,
      queuedBuilders: context.admissionQueue.filter((entry) => entry.role === "builder").length,
    },
  };
}

function notify(context, event) {
  try {
    context?.onEvent?.(event);
    context?.forwardTelemetry?.(event);
  } catch {
    // Budget telemetry must never break a run.
  }
}

// UI telemetry must pass through the run's sequenced emitter, not bypass it.
export function bindAgentBudgetEvents(emit) {
  const context = budgetStorage.getStore();
  if (context && !context.forwardTelemetry) context.forwardTelemetry = emit;
}

function elevate(context, nextProfile, reason) {
  if (!PROFILE_LIMITS[nextProfile] || profileAtLeast(context.profile, nextProfile)) return false;
  context.profile = nextProfile;
  context.limits = mergeLimits(PROFILE_LIMITS[nextProfile], context.plan.hardLimits || {});
  if (context.plan.builderConcurrency != null) {
    context.limits = mergeLimits(context.limits, {
      maxActiveSubagents: context.plan.hardLimits?.maxActiveSubagents ?? Math.max(context.limits.maxActiveSubagents, context.plan.builderConcurrency),
      roles: { builder: context.plan.hardLimits?.roles?.builder ?? context.plan.builderConcurrency },
    });
  }
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
  if (
    event.systemOwned &&
    ["subagent.started", "subagent.completed", "subagent.failed"].includes(
      event.type,
    )
  ) {
    return;
  }

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
    const continuing = context.state.startedIds.has(agentId);
    const roleLimit = context.limits.roles[role] ?? context.limits.roles.other ?? 0;
    const renewable = role === "builder" && context.plan.renewableBuilders;
    const chargedTotal = context.state.totalStarted - (context.plan.renewableBuilders ? context.state.byRole.builder || 0 : 0);
    const activeBuilders = [...context.state.activeRoles.values()].filter((value) => value === "builder").length;
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
      (!continuing && !renewable && chargedTotal >= context.limits.maxTotalSubagents) ||
      context.state.activeIds.size >= context.limits.maxActiveSubagents ||
      (role === "builder" && context.plan.builderConcurrency != null && activeBuilders >= context.plan.builderConcurrency) ||
      (!continuing && !renewable && roleCount >= roleLimit) ||
      (role === "builder" && roleLimit === 0)
    ) {
      notify(context, { type: "agent_budget.denied", ...detail });
      throw budgetError(
        `Agent delegation blocked by the ${context.profile} task budget (${event.role || role}).`,
        detail,
      );
    }
    if (!continuing) {
      context.state.totalStarted += 1;
      context.state.byRole[role] = roleCount + 1;
      context.state.startedIds.add(agentId);
    }
    context.state.activeIds.add(agentId);
    context.state.activeRoles.set(agentId, role);
    notify(context, {
      type: "agent_budget.consumed",
      agentId,
      role: event.role || role,
      profile: context.profile,
      remaining: Math.max(0, context.limits.maxTotalSubagents - context.state.totalStarted),
    });
    return;
  }

  if (["subagent.completed", "subagent.failed", "subagent.cancelled"].includes(event.type) && event.agentId) {
    context.state.activeIds.delete(String(event.agentId));
    context.state.activeRoles.delete(String(event.agentId));
  }
}

export function agentBudgetAllowsTool(toolName) {
  const context = budgetStorage.getStore();
  if (!context) return true;
  if (toolName !== "delegate_subagent") return true;
  return context.limits.maxTotalSubagents > 0 || context.plan.mayDelegate && context.plan.hardLimits?.maxTotalSubagents !== 0;
}

export function requestAgentBudgetRole(role) {
  const context = budgetStorage.getStore();
  if (!context || !context.plan.mayDelegate || context.limits.roles[role] > 0) return;
  if (context.plan.hardLimits?.roles?.[role] === 0 || context.plan.hardLimits?.maxTotalSubagents === 0) return;
  elevate(context, role === "builder" ? "large" : "standard", "model-requested-focused-delegation");
}

// Admission queues execution instead of charging failed launch attempts.
// A slot covers the worker's full execution including Builder integration.
export async function withAgentBudgetAdmission({ role, signal, systemOwned = false }, execute) {
  const context = budgetStorage.getStore();
  if (!context || systemOwned) return execute();
  requestAgentBudgetRole(role);
  const limit = context.limits.maxActiveSubagents;
  if (!limit || role === "builder" && context.plan.builderConcurrency === 0) throw budgetError("Task budget prohibits active subagents.", { role });
  const available = (kind) => context.admissionActive < context.limits.maxActiveSubagents && (kind !== "builder" || context.plan.builderConcurrency == null || context.admissionBuilders < context.plan.builderConcurrency);
  const telemetry = () => notify(context, { type: "agent_budget.queue", runningBuilders: context.admissionBuilders, queuedBuilders: context.admissionQueue.filter((entry) => entry.role === "builder").length, builderConcurrency: context.plan.builderConcurrency });
  await new Promise((resolveWait, rejectWait) => {
    const entry = { role, grant: () => { signal?.removeEventListener("abort", abort); context.admissionActive++; if (role === "builder") context.admissionBuilders++; telemetry(); resolveWait(); } };
    const abort = () => {
      context.admissionQueue = context.admissionQueue.filter((item) => item !== entry);
      telemetry();
      rejectWait(Object.assign(new Error("Queued worker cancelled."), { name: "AbortError" }));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (available(role)) entry.grant();
    else { context.admissionQueue.push(entry); telemetry(); }
  });
  try { signal?.throwIfAborted(); return await execute(); }
  finally {
    context.admissionActive--;
    if (role === "builder") context.admissionBuilders--;
    for (let index = 0; index < context.admissionQueue.length;) {
      if (available(context.admissionQueue[index].role)) context.admissionQueue.splice(index, 1)[0].grant();
      else index++;
    }
    telemetry();
  }
}

export function currentAgentBudget() {
  return publicPlan(budgetStorage.getStore());
}

export function restoreAgentBudget(snapshot) {
  const context = budgetStorage.getStore();
  if (!context || !snapshot?.state) return;
  elevate(context, snapshot.profile, "restore-task-budget");
  context.state.totalStarted = Math.max(context.state.totalStarted, Number(snapshot.state.totalStarted) || 0);
  for (const [role, count] of Object.entries(snapshot.state.byRole || {})) context.state.byRole[role] = Math.max(context.state.byRole[role] || 0, Number(count) || 0);
  for (const id of snapshot.state.startedIds || []) context.state.startedIds.add(String(id));
}

export function currentExecutionMode() {
  return budgetStorage.getStore()?.executionMode || null;
}

export function runWithAgentBudget(plan, { onEvent = null } = {}, fn) {
  if (typeof fn !== "function") throw new Error("runWithAgentBudget requires a function.");
  const normalized = plan?.limits ? plan : planAgentBudget({});
  const parentContext = budgetStorage.getStore();
  const context = {
    plan: normalized,
    profile: normalized.profile,
    executionMode: normalized.executionMode
      ? normalizeExecutionMode(normalized.executionMode)
      : parentContext?.executionMode || "safe",
    limits: normalized.limits,
    onEvent,
    admissionActive: 0,
    admissionBuilders: 0,
    admissionQueue: [],
    state: {
      totalStarted: 0,
      activeIds: new Set(),
      activeRoles: new Map(),
      startedIds: new Set(),
      byRole: {},
      changedFiles: new Set(),
      planSteps: 0,
    },
  };
  notify(context, {
    type: "agent_budget.planned",
    profile: context.profile,
    executionMode: context.executionMode,
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

export * from "./agent-runtime-core.js";

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  captureWorkspaceState,
  runHarness as runLegacyHarness,
} from "./agent-runtime-core.js";
import {
  mergeTokenUsage,
  runWithCollaborationContext,
} from "./agent-context.js";
import { createWitnessMonitor } from "./witness-monitor.js";
import {
  currentAgentBudget,
  enforceAgentBudgetEvent,
  planAgentBudget,
  runWithAgentBudget,
} from "./harness/agent-budget.js";
import {
  createAgentDefinitionRegistry,
  loadWorkspaceAgentDefinitions,
} from "./harness/agent-definitions.js";
import { BuilderWorkspaceManager } from "./harness/builder-workspace.js";
import {
  CollaborationMailbox,
  approveBuilderPlan,
  compareBuilderHandoffs,
  createCollaborationAudit,
  normalizeBuilderHandoff,
  normalizeCollaborationContract,
} from "./harness/collaboration.js";
import { getDefaultHarnessEventBus } from "./harness/event-bus.js";
import { HarnessScheduler } from "./harness/scheduler.js";
import { scopesOverlap } from "./harness/scope-leases.js";
import { createTaskGraph } from "./harness/task-graph.js";

const MAX_BUILDERS = 2;
const MAX_PLANNER_RESULT_CHARS = 32_000;
const FINAL_LIFECYCLE_EVENTS = new Set([
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "witness.updated",
]);

function latestUserText(messages) {
  return String(
    [...(Array.isArray(messages) ? messages : [])]
      .reverse()
      .find(
        (message) =>
          message?.role === "user" && typeof message?.content === "string",
      )?.content || "",
  ).trim();
}

function parseJsonObject(value) {
  const source = String(value || "").trim();
  if (!source) return null;
  const unfenced = source
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function lineChanges(beforeContent, afterContent) {
  const lines = (value) =>
    String(value || "") === ""
      ? []
      : String(value).replace(/\r\n/g, "\n").split("\n");
  const before = lines(beforeContent);
  const after = lines(afterContent);
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] ===
      after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: Math.max(0, after.length - prefix - suffix),
    deletions: Math.max(0, before.length - prefix - suffix),
  };
}

function snapshotDelta(beforeSnapshot, afterSnapshot) {
  if (!beforeSnapshot?.files || !afterSnapshot?.files) return [];
  const changes = [];
  const paths = new Set([
    ...beforeSnapshot.files.keys(),
    ...afterSnapshot.files.keys(),
  ]);
  for (const path of [...paths].sort()) {
    const before = beforeSnapshot.files.get(path) || null;
    const after = afterSnapshot.files.get(path) || null;
    if (
      Boolean(before) === Boolean(after) &&
      before?.binary === after?.binary &&
      before?.content === after?.content
    ) {
      continue;
    }
    const binary = Boolean(before?.binary || after?.binary);
    const change = {
      path,
      beforeContent: before?.content || "",
      afterContent: after?.content || "",
      beforeMissing: !before,
      afterMissing: !after,
      binary,
      artifact: null,
      created: !before,
      deleted: !after,
      reverted: false,
      source: "orchestrated-workspace-snapshot",
    };
    if (binary) {
      change.additions = 0;
      change.deletions = 0;
    } else {
      Object.assign(
        change,
        lineChanges(change.beforeContent, change.afterContent),
      );
    }
    changes.push(change);
  }
  return changes;
}

function orchestrationBudget(options) {
  return currentAgentBudget() || planAgentBudget(options || {});
}

export function shouldUseBuilderOrchestration(options = {}, budget = null) {
  const activeBudget = budget || orchestrationBudget(options);
  const builderLimit = Number(activeBudget?.limits?.roles?.builder || 0);
  return Boolean(
    options?.builderOrchestration !== false &&
      options?.workspacePath &&
      options?.permission === "workspace-write" &&
      builderLimit > 0 &&
      Number(activeBudget?.limits?.maxActiveSubagents || 0) > 0,
  );
}

function plannerPrompt(request, builderLimit) {
  return [
    "AporiaX Harness orchestration preflight.",
    "Do not edit files. Inspect the repository only as much as necessary to decide whether the current implementation task can be split safely across Builder workers.",
    `At most ${Math.min(MAX_BUILDERS, Math.max(1, builderLimit))} Builder workers may be proposed.`,
    "Builder workers must own explicit, non-overlapping workspace-relative write scopes. The workspace root '.' is forbidden. Two scopes conflict when either is the same as, an ancestor of, or a descendant of the other.",
    "Do not create a Builder merely to make the team larger. If one coherent implementation is safer or the task is not actually a write task, return parallelize=false.",
    "Before splitting work, define one shared integration contract containing only cross-worker decisions that must stay consistent: UI conventions, API fields/routes, schema/state contracts, security rules, shared files owned by Main, and acceptance checks.",
    "Shared coordination files such as package.json, lockfiles, shared routing tables, generated indexes, shared stores, and common design-system components should normally be listed in contract.sharedFiles and left to Lead/Main instead of being owned by a Builder.",
    "Each Builder task must declare contractKeys for the shared invariants it must obey and a concise approvedPlan. This is the Lead plan-approval boundary; do not leave incompatible choices for Builders to negotiate after they start.",
    "Use dependsOn when one Builder must receive another Builder's handoff before starting. Independent Builders may run in parallel.",
    "Return JSON only with this schema:",
    JSON.stringify({
      parallelize: true,
      reason: "short reason",
      contract: {
        title: "Authentication integration contract",
        goal: "Login and registration must feel and behave like one feature",
        invariants: [
          {
            key: "auth.identifier",
            category: "api",
            value: "identifier:string",
            severity: "must",
            description: "Both forms and API payloads use identifier",
          },
          {
            key: "auth.form-style",
            category: "ui",
            value: "reuse existing AuthForm/Input/Button styling",
            severity: "must",
            description: "Login and registration share the same visual language",
          },
        ],
        sharedFiles: ["src/stores/auth.ts", "src/router/index.ts"],
        acceptance: ["Login and registration use the same auth field naming"],
      },
      tasks: [
        {
          id: "builder-login",
          title: "Implement login",
          task: "Implement the login feature inside its owned module.",
          writeScopes: ["src/features/login"],
          dependsOn: [],
          contractKeys: ["auth.identifier", "auth.form-style"],
          approvedPlan: {
            approach: "Reuse existing auth form primitives and emit the canonical login payload",
            assumptions: ["Shared auth store changes remain with Main"],
          },
        },
      ],
    }),
    `Current user request:\n${String(request || "").slice(0, 12_000)}`,
  ].join("\n\n");
}

export function normalizeBuilderOrchestrationPlan(
  raw,
  { builderLimit = MAX_BUILDERS } = {},
) {
  const parsed = typeof raw === "string" ? parseJsonObject(raw) : raw;
  if (!parsed || parsed.parallelize !== true || !Array.isArray(parsed.tasks)) {
    return {
      parallelize: false,
      reason: String(parsed?.reason || "planner-declined-parallelization"),
      tasks: [],
      contract: null,
      approval: { approved: false, reasons: ["planner-declined-parallelization"] },
    };
  }
  const limit = Math.min(
    MAX_BUILDERS,
    Math.max(0, Number(builderLimit) || 0),
  );
  const candidates = [];
  const ids = new Set();
  for (const candidate of parsed.tasks.slice(0, limit)) {
    const id = String(candidate?.id || "").trim();
    const task = String(candidate?.task || "").trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id) || !task) {
      continue;
    }
    ids.add(id);
    candidates.push({
      id,
      title: String(candidate?.title || id).trim().slice(0, 240),
      role: "builder",
      task: task.slice(0, 4_000),
      writeScopes: candidate?.writeScopes || candidate?.scope || [],
      dependsOn: Array.isArray(candidate?.dependsOn)
        ? candidate.dependsOn.map(String).filter(Boolean)
        : Array.isArray(candidate?.depends_on)
          ? candidate.depends_on.map(String).filter(Boolean)
          : [],
      contractKeys: Array.isArray(candidate?.contractKeys || candidate?.contract_keys)
        ? candidate.contractKeys || candidate.contract_keys
        : [],
      approvedPlan: candidate?.approvedPlan || candidate?.approved_plan || candidate?.plan || {},
    });
  }
  if (!candidates.length) {
    return {
      parallelize: false,
      reason: "planner-returned-no-valid-builder-task",
      tasks: [],
      contract: null,
      approval: { approved: false, reasons: ["no-valid-builder-task"] },
    };
  }

  let graph;
  try {
    graph = createTaskGraph(candidates);
  } catch (error) {
    return {
      parallelize: false,
      reason: `invalid-task-graph: ${error.message}`,
      tasks: [],
      contract: null,
      approval: { approved: false, reasons: [error.message] },
    };
  }
  const normalizedGraphTasks = graph.snapshot();
  const candidateById = new Map(candidates.map((task) => [task.id, task]));
  const tasks = normalizedGraphTasks.map((task) => ({
    ...task,
    contractKeys: candidateById.get(task.id)?.contractKeys || [],
    approvedPlan: candidateById.get(task.id)?.approvedPlan || {},
  }));

  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < tasks.length;
      rightIndex += 1
    ) {
      for (const left of tasks[leftIndex].writeScopes) {
        for (const right of tasks[rightIndex].writeScopes) {
          if (scopesOverlap(left, right)) {
            return {
              parallelize: false,
              reason: `overlapping-builder-scopes: ${left} <> ${right}`,
              tasks: [],
              contract: null,
              approval: {
                approved: false,
                reasons: [`overlapping-builder-scopes:${left}:${right}`],
              },
            };
          }
        }
      }
    }
  }

  const contract = normalizeCollaborationContract(parsed.contract || {}, {
    tasks,
  });
  const approval = approveBuilderPlan({ contract, tasks });
  if (!approval.approved) {
    return {
      parallelize: false,
      reason: `plan-approval-rejected: ${approval.reasons.join(", ")}`,
      tasks: approval.tasks,
      contract,
      approval,
    };
  }
  return {
    parallelize: true,
    reason: String(parsed.reason || "safe-builder-split").slice(0, 800),
    tasks: approval.tasks,
    contract,
    approval,
  };
}

function builderPrompt({ definition, node, request, contract, inbox }) {
  return [
    `You are an AporiaX Builder worker (${node.id}).`,
    definition?.systemPrompt ||
      "Implement only the delegated change inside the explicit write scope.",
    "You are working in an isolated Git worktree. Your changes are provisional until Harness conflict-checks and merges them.",
    `Your exclusive write scopes are: ${node.writeScopes.join(", ")}.`,
    "Never modify a path outside those scopes. Do not broaden your scope. Do not run arbitrary commands. Do not edit shared coordination files unless they are explicitly inside your write scopes.",
    "The Shared Collaboration Contract is authoritative. Do not invent a local UI/API/schema convention that contradicts it. If something is ambiguous, record a QUESTION or BLOCKER for Main instead of silently choosing an incompatible convention.",
    `Contract keys you are responsible for: ${node.contractKeys?.join(", ") || "none"}.`,
    `Lead-approved implementation plan: ${JSON.stringify(node.approvedPlan || {})}`,
    inbox?.length
      ? `Mailbox messages available before you start:\n${JSON.stringify(inbox)}`
      : "No unresolved mailbox messages are addressed to you.",
    "Use read/search tools to understand dependencies, then implement the delegated task completely with write_file/apply_patch.",
    "Before finishing, re-read your changed files and correct obvious defects.",
    "Your final answer MUST be one JSON object. Do not wrap it in Markdown. Use this shape:",
    JSON.stringify({
      summary: "what was implemented",
      assumptions: ["integration assumption"],
      requiresMain: ["shared file or cross-cutting work Main must finish"],
      contractAssertions: [
        {
          key: "one assigned contract key",
          value: "the exact contract value you implemented",
          evidence: "workspace-relative file or concise evidence",
        },
      ],
      messages: [
        {
          type: "question|notice|blocker",
          to: "main|another-builder-id",
          topic: "short topic",
          detail: "concise coordination message",
          blocking: false,
        },
      ],
    }),
    `Shared Collaboration Contract:\n${JSON.stringify(contract).slice(0, 18_000)}`,
    `Delegated task:\n${node.task || node.title}`,
    `Original user request for context:\n${String(request || "").slice(0, 8_000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function integrationPrompt({ plan, builderResults, mailbox, semanticCheck }) {
  const completed = builderResults.filter((item) => item.status === "completed");
  const failed = builderResults.filter((item) => item.status !== "completed");
  return [
    "AporiaX Harness orchestration update for the Lead/Main agent.",
    "Builder output is provisional and must not be trusted blindly. Inspect git_diff and re-read the affected current files before relying on it. Resolve integration issues yourself and continue the original user request to completion.",
    plan.contract
      ? `Shared Collaboration Contract (authoritative for Main, Review, and Verify):\n${JSON.stringify(plan.contract).slice(0, 24_000)}`
      : "",
    completed.length
      ? `Merged Builder handoffs:\n${JSON.stringify(
          completed.map((item) => ({
            id: item.id,
            title: item.title,
            writeScopes: item.writeScopes,
            changedPaths: item.changedPaths,
            handoff: item.handoff,
          })),
        ).slice(0, 24_000)}`
      : "No Builder output was merged.",
    failed.length
      ? `Builder work that did not merge or complete:\n${JSON.stringify(
          failed.map((item) => ({
            id: item.id,
            title: item.title,
            writeScopes: item.writeScopes,
            status: item.status,
            error: item.error || item.summary,
          })),
        ).slice(0, 10_000)}`
      : "",
    mailbox.length
      ? `Unresolved Builder/Main mailbox:\n${JSON.stringify(mailbox).slice(0, 12_000)}`
      : "",
    semanticCheck && !semanticCheck.passed
      ? `Harness found semantic contract conflicts that Main MUST reconcile before finishing:\n${JSON.stringify(semanticCheck.conflicts)}`
      : semanticCheck?.warnings?.length
        ? `Contract handoff warnings to inspect:\n${JSON.stringify(semanticCheck.warnings)}`
        : "",
    `Planner rationale: ${plan.reason}`,
    "Review and Verify agents must judge the current implementation against the same Shared Collaboration Contract, not only against local code style. Do not mark the task complete while a must-level invariant or unresolved blocking mailbox item is violated.",
    "Do not redo correct Builder work just for activity. Focus on shared files, cross-cutting integration, semantic conflicts, review findings, and verification. Use additional subagents only when the active Agent budget justifies them.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function quietControl(control) {
  if (!control) return null;
  return {
    waitIfPaused: (...args) => control.waitIfPaused?.(...args),
    consumeSteering: () => [],
  };
}

function builderChildBudget() {
  return planAgentBudget({
    workspacePath: "builder-worktree",
    permission: "builder-write",
    messages: [
      {
        role: "user",
        content: "isolated Builder implementation",
      },
    ],
    agentBudget: {
      profile: "light",
      maxTotalSubagents: 0,
      maxActiveSubagents: 0,
      roles: {
        explore: 0,
        review: 0,
        verify: 0,
        curator: 0,
        builder: 0,
        other: 0,
      },
    },
  });
}

function plannerChildBudget() {
  return planAgentBudget({
    workspacePath: "planner-workspace",
    permission: "read-only",
    messages: [{ role: "user", content: "orchestration preflight" }],
    agentBudget: {
      profile: "direct",
      maxTotalSubagents: 0,
      maxActiveSubagents: 0,
    },
  });
}

function createAuditedWitness(forwardManual) {
  const monitor = createWitnessMonitor({ emit: forwardManual });
  const audit = createCollaborationAudit();
  return {
    observe(event) {
      audit.observe(event);
      monitor.observe(event);
    },
    snapshot() {
      return {
        ...monitor.snapshot(),
        collaboration: audit.snapshot(),
      };
    },
    dispose() {
      monitor.dispose();
    },
  };
}

async function runOrchestratedHarness(options) {
  const budget = orchestrationBudget(options);
  if (!shouldUseBuilderOrchestration(options, budget)) {
    return runLegacyHarness(options);
  }

  const startedAt = new Date().toISOString();
  const forwardManual = (event) => {
    const payload = {
      timestamp: event?.timestamp || new Date().toISOString(),
      ...event,
    };
    options.onEvent?.(payload);
    const sharedBus = getDefaultHarnessEventBus();
    sharedBus?.emit({ ...payload, orchestration: true });
  };
  const witness = createAuditedWitness(forwardManual);
  const emit = (event, { budgetEvent = true } = {}) => {
    const payload = {
      timestamp: event?.timestamp || new Date().toISOString(),
      ...event,
    };
    if (budgetEvent) enforceAgentBudgetEvent(payload);
    witness.observe(payload);
    forwardManual(payload);
    return payload;
  };
  const observeFinalRuntimeEvent = (event) => {
    if (!event || FINAL_LIFECYCLE_EVENTS.has(event.type)) return;
    witness.observe(event);
    options.onEvent?.(event);
  };

  const request = latestUserText(options.messages);
  const builderLimit = Math.min(
    MAX_BUILDERS,
    Math.max(0, Number(budget?.limits?.roles?.builder || 0)),
  );
  let totalUsage = null;
  let beforeSnapshot = null;
  let plan = {
    parallelize: false,
    reason: "not-planned",
    tasks: [],
    contract: null,
    approval: null,
  };
  const builderResults = [];
  const mailbox = new CollaborationMailbox();
  let semanticCheck = null;
  let orchestrationError = "";

  emit(
    {
      type: "turn.started",
      provider: options.provider?.id,
      providerName: options.provider?.name,
      model: options.modelId,
      workspace: Boolean(options.workspacePath),
      permissionMode: options.permission,
      approvalMode: options.approvalMode,
      agentBudget: budget,
      orchestration: {
        enabled: true,
        builderLimit,
        collaboration: true,
      },
    },
    { budgetEvent: false },
  );

  try {
    beforeSnapshot = await captureWorkspaceState(options.workspacePath, {
      signal: options.signal,
    });
  } catch (error) {
    orchestrationError = `initial-snapshot: ${error.message}`;
  }

  if (!orchestrationError) {
    try {
      emit(
        {
          type: "orchestration.planner.started",
          builderLimit,
        },
        { budgetEvent: false },
      );
      const plannerResult = await runWithAgentBudget(
        plannerChildBudget(),
        {},
        () =>
          runLegacyHarness({
            ...options,
            runId: `${options.runId || "run"}-orchestration-planner`,
            taskId: `${options.taskId || "task"}-orchestration-planner`,
            permission: "read-only",
            approvalMode: "manual",
            messages: [
              {
                role: "user",
                content: plannerPrompt(request, builderLimit),
              },
            ],
            control: quietControl(options.control),
            requestApproval: async () => ({ approved: false }),
            understandingDirectory: null,
            onEvent: () => undefined,
          }),
      );
      totalUsage = mergeTokenUsage(totalUsage, plannerResult?.usage);
      plan = normalizeBuilderOrchestrationPlan(
        String(plannerResult?.content || "").slice(
          0,
          MAX_PLANNER_RESULT_CHARS,
        ),
        { builderLimit },
      );
      if (plan.contract) {
        emit(
          {
            type: "collaboration.contract.created",
            contract: plan.contract,
          },
          { budgetEvent: false },
        );
      }
      emit(
        {
          type: plan.approval?.approved
            ? "collaboration.plan.approved"
            : "collaboration.plan.rejected",
          reasons: plan.approval?.reasons || [],
          tasks: (plan.approval?.tasks || plan.tasks || []).map((task) => ({
            id: task.id,
            title: task.title,
            writeScopes: task.writeScopes,
            contractKeys: task.contractKeys || [],
          })),
        },
        { budgetEvent: false },
      );
      emit(
        {
          type: "orchestration.planner.completed",
          parallelize: plan.parallelize,
          reason: plan.reason,
          contractId: plan.contract?.id || null,
          tasks: plan.tasks.map((task) => ({
            id: task.id,
            title: task.title,
            writeScopes: task.writeScopes,
            dependsOn: task.dependsOn,
            contractKeys: task.contractKeys || [],
          })),
        },
        { budgetEvent: false },
      );
    } catch (error) {
      if (error?.name === "AbortError" || options.signal?.aborted) throw error;
      orchestrationError = `planner: ${error.message}`;
      emit(
        {
          type: "orchestration.planner.failed",
          error: error.message,
        },
        { budgetEvent: false },
      );
    }
  }

  if (!orchestrationError && plan.parallelize && plan.tasks.length) {
    try {
      const workspaceRoot = await realpath(resolve(options.workspacePath));
      const registry = await loadWorkspaceAgentDefinitions(
        workspaceRoot,
        { registry: createAgentDefinitionRegistry() },
      );
      const builderDefinition = registry.resolve("builder");
      if (!builderDefinition) {
        throw new Error("Builder Agent definition is unavailable.");
      }
      const graph = createTaskGraph(plan.tasks);
      const taskMeta = new Map(plan.tasks.map((task) => [task.id, task]));
      const scheduler = new HarnessScheduler({
        concurrency: Math.min(builderLimit, MAX_BUILDERS),
      });
      const workspaces = new BuilderWorkspaceManager();
      emit(
        {
          type: "task_graph.planned",
          tasks: graph.snapshot(),
          contractId: plan.contract?.id || null,
        },
        { budgetEvent: false },
      );

      while (true) {
        const ready = graph.ready({ role: "builder" });
        if (!ready.length) break;
        const scheduled = ready.map((graphNode) => {
          const meta = taskMeta.get(graphNode.id) || {};
          const node = {
            ...graphNode,
            task: meta.task || graphNode.task,
            contractKeys: meta.contractKeys || [],
            approvedPlan: meta.approvedPlan || {},
          };
          const agentId = `${options.runId || "run"}-builder-${node.id}`;
          graph.claim(node.id, agentId);
          return scheduler.enqueue({
            id: `builder:${node.id}`,
            kind: "builder",
            priority: 10,
            metadata: {
              taskId: node.id,
              agentId,
              writeScopes: node.writeScopes,
              contractKeys: node.contractKeys,
            },
            run: async () => {
              let workspace = null;
              let started = false;
              try {
                const inbox = mailbox.forTarget(node.id);
                emit({
                  type: "subagent.started",
                  agentId,
                  role: "builder",
                  task: node.task || node.title,
                  scope: node.writeScopes,
                  background: true,
                  contractId: plan.contract?.id || null,
                  contractKeys: node.contractKeys,
                  inboxCount: inbox.length,
                });
                started = true;
                workspace = await workspaces.open({
                  workspaceRoot,
                  agentId,
                  writeScopes: node.writeScopes,
                });
                const childContext = {
                  contract: plan.contract,
                  task: {
                    id: node.id,
                    title: node.title,
                    writeScopes: node.writeScopes,
                    contractKeys: node.contractKeys,
                    approvedPlan: node.approvedPlan,
                  },
                  inbox,
                };
                const childResult = await runWithAgentBudget(
                  builderChildBudget(),
                  {},
                  () =>
                    runWithCollaborationContext(childContext, () =>
                      runLegacyHarness({
                        ...options,
                        runId: `${agentId}-worker`,
                        taskId: `${options.taskId || "task"}:${node.id}`,
                        workspacePath: workspace.workspaceRoot,
                        permission: "builder-write",
                        approvalMode: "manual",
                        messages: [
                          {
                            role: "user",
                            content: builderPrompt({
                              definition: builderDefinition,
                              node,
                              request,
                              contract: plan.contract,
                              inbox,
                            }),
                          },
                        ],
                        control: quietControl(options.control),
                        requestApproval: async () => ({ approved: false }),
                        memoryDirectory: null,
                        understandingDirectory: null,
                        onEvent: (event) => {
                          if (!event || event.type === "witness.updated") return;
                          if (event.type === "tool.started") {
                            emit(
                              {
                                ...event,
                                type: "subagent.tool.started",
                                agentId,
                                role: "builder",
                              },
                              { budgetEvent: false },
                            );
                          } else if (event.type === "tool.completed") {
                            emit(
                              {
                                ...event,
                                type: "subagent.tool.completed",
                                agentId,
                                role: "builder",
                              },
                              { budgetEvent: false },
                            );
                          } else if (event.type === "file.changed") {
                            emit(
                              {
                                ...event,
                                type: "builder.file.changed",
                                agentId,
                              },
                              { budgetEvent: false },
                            );
                          }
                        },
                      }),
                    ),
                );
                totalUsage = mergeTokenUsage(
                  totalUsage,
                  childResult?.usage,
                );
                if (childResult?.status !== "completed") {
                  throw new Error(
                    childResult?.content ||
                      childResult?.error ||
                      "Builder worker did not complete.",
                  );
                }

                const handoff = normalizeBuilderHandoff(childResult.content, {
                  task: node,
                  contract: plan.contract,
                });
                emit(
                  {
                    type: "collaboration.handoff.received",
                    agentId,
                    builderId: node.id,
                    structured: handoff.structured,
                    contractAssertions: handoff.contractAssertions,
                    requiresMain: handoff.requiresMain,
                  },
                  { budgetEvent: false },
                );
                for (const rawMessage of handoff.messages) {
                  const message = mailbox.post(rawMessage);
                  emit(
                    {
                      type: "collaboration.mailbox.message",
                      agentId,
                      builderId: node.id,
                      message,
                    },
                    { budgetEvent: false },
                  );
                }

                const preMergeContractCheck = compareBuilderHandoffs({
                  contract: plan.contract,
                  tasks: plan.tasks,
                  handoffs: [{ id: node.id, handoff }],
                });
                const explicitContractMismatch = preMergeContractCheck.conflicts.filter(
                  (item) => item.type === "contract-mismatch",
                );
                if (explicitContractMismatch.length) {
                  emit(
                    {
                      type: "collaboration.contract.violation",
                      agentId,
                      builderId: node.id,
                      conflicts: explicitContractMismatch,
                    },
                    { budgetEvent: false },
                  );
                  throw new Error(
                    `Builder explicitly contradicted the shared contract: ${explicitContractMismatch
                      .map((item) => item.key)
                      .join(", ")}`,
                  );
                }

                const merged = await workspace.merge();
                if (!merged.merged) {
                  throw new Error(
                    `Builder merge rejected: ${merged.conflicts.join(", ")}`,
                  );
                }
                for (const change of merged.checkpoints || []) {
                  emit(
                    {
                      type: "file.changed",
                      path: change.path,
                      additions: change.additions,
                      deletions: change.deletions,
                      binary: false,
                      created: change.created,
                      deleted: change.deleted,
                      source: "builder-merge",
                      agentId,
                    },
                    { budgetEvent: false },
                  );
                }
                const result = {
                  id: node.id,
                  title: node.title,
                  status: "completed",
                  agentId,
                  writeScopes: node.writeScopes,
                  contractKeys: node.contractKeys,
                  changedPaths: (merged.checkpoints || []).map(
                    (change) => change.path,
                  ),
                  checkpoints: merged.checkpoints || [],
                  handoff,
                  summary: handoff.summary || String(childResult.content || "").trim().slice(0, 4_000),
                  usage: childResult.usage || null,
                };
                graph.complete(node.id, result);
                emit({
                  type: "subagent.completed",
                  agentId,
                  role: "builder",
                  status: "completed",
                  summary: result.summary,
                  changedPaths: result.changedPaths,
                  contractId: plan.contract?.id || null,
                });
                return result;
              } catch (error) {
                if (error?.name === "AbortError" || options.signal?.aborted) {
                  throw error;
                }
                const result = {
                  id: node.id,
                  title: node.title,
                  status: "failed",
                  agentId,
                  writeScopes: node.writeScopes,
                  contractKeys: node.contractKeys,
                  changedPaths: [],
                  checkpoints: [],
                  handoff: null,
                  error: String(error?.message || error).slice(0, 2_000),
                  summary: String(error?.message || error).slice(0, 2_000),
                };
                graph.fail(node.id, result);
                if (started) {
                  emit({
                    type: "subagent.failed",
                    agentId,
                    role: "builder",
                    error: result.error,
                  });
                }
                return result;
              } finally {
                await workspace?.close?.().catch(() => undefined);
              }
            },
          });
        });
        const settled = await Promise.all(
          scheduled.map((job) => job.promise),
        );
        builderResults.push(...settled);
      }
      for (const blocked of graph.blocked()) {
        builderResults.push({
          id: blocked.id,
          title: blocked.title,
          status: "blocked",
          agentId: blocked.agentId,
          writeScopes: blocked.writeScopes,
          contractKeys: taskMeta.get(blocked.id)?.contractKeys || [],
          changedPaths: [],
          checkpoints: [],
          handoff: null,
          error: "A dependency Builder failed.",
          summary: "A dependency Builder failed.",
        });
      }
      semanticCheck = compareBuilderHandoffs({
        contract: plan.contract,
        tasks: plan.tasks,
        handoffs: builderResults
          .filter((item) => item.handoff)
          .map((item) => ({ id: item.id, handoff: item.handoff })),
      });
      emit(
        {
          type: "collaboration.semantic.checked",
          result: semanticCheck,
        },
        { budgetEvent: false },
      );
      if (!semanticCheck.passed) {
        emit(
          {
            type: "collaboration.semantic.conflict",
            conflicts: semanticCheck.conflicts,
          },
          { budgetEvent: false },
        );
      }
      emit(
        {
          type: "task_graph.completed",
          tasks: graph.snapshot(),
        },
        { budgetEvent: false },
      );
    } catch (error) {
      if (error?.name === "AbortError" || options.signal?.aborted) throw error;
      orchestrationError = `builders: ${error.message}`;
      emit(
        {
          type: "orchestration.builders.failed",
          error: error.message,
        },
        { budgetEvent: false },
      );
    }
  }

  const finalMessages = Array.isArray(options.messages)
    ? [...options.messages]
    : [];
  if (builderResults.length || orchestrationError) {
    finalMessages.push({
      role: "user",
      content: integrationPrompt({
        plan: {
          ...plan,
          reason: orchestrationError
            ? `${plan.reason}; ${orchestrationError}`
            : plan.reason,
        },
        builderResults,
        mailbox: mailbox.forTarget("main"),
        semanticCheck,
      }),
    });
  }

  const finalCollaborationContext =
    plan.contract && builderResults.length
      ? {
          contract: plan.contract,
          handoffs: builderResults
            .filter((item) => item.handoff)
            .map((item) => ({ id: item.id, handoff: item.handoff })),
          inbox: mailbox.forTarget("main"),
          semanticCheck,
        }
      : null;

  let finalResult;
  try {
    finalResult = finalCollaborationContext
      ? await runWithCollaborationContext(finalCollaborationContext, () =>
          runLegacyHarness({
            ...options,
            messages: finalMessages,
            onEvent: observeFinalRuntimeEvent,
          }),
        )
      : await runLegacyHarness({
          ...options,
          messages: finalMessages,
          onEvent: observeFinalRuntimeEvent,
        });
    totalUsage = mergeTokenUsage(totalUsage, finalResult?.usage);
  } catch (error) {
    witness.dispose();
    throw error;
  }

  let afterSnapshot = null;
  let snapshotWarning = "";
  try {
    afterSnapshot = await captureWorkspaceState(options.workspacePath);
  } catch (error) {
    snapshotWarning = error.message;
  }
  const combinedChanges =
    beforeSnapshot && afterSnapshot
      ? snapshotDelta(beforeSnapshot, afterSnapshot)
      : finalResult?.changes || [];
  const status = finalResult?.status || "failed";
  finalResult = {
    ...finalResult,
    usage: totalUsage,
    changes: combinedChanges,
    anchor: {
      id: options.runId || finalResult?.anchor?.id || `anchor-${Date.now()}`,
      startedAt,
      completedAt: new Date().toISOString(),
      status,
      scope: "workspace-delta",
      changedFiles: combinedChanges.length,
      capturedFiles:
        afterSnapshot?.capturedFiles ||
        finalResult?.anchor?.capturedFiles ||
        0,
      skippedFiles: Math.max(
        beforeSnapshot?.skippedFiles || 0,
        afterSnapshot?.skippedFiles || 0,
        finalResult?.anchor?.skippedFiles || 0,
      ),
      snapshotComplete: Boolean(
        beforeSnapshot &&
          afterSnapshot &&
          !beforeSnapshot.truncated &&
          !afterSnapshot.truncated &&
          !snapshotWarning,
      ),
      warning:
        snapshotWarning ||
        (!beforeSnapshot
          ? "Orchestrated pre-task workspace snapshot was unavailable."
          : ""),
    },
    orchestration: {
      enabled: true,
      budgetProfile: budget?.profile || null,
      builderLimit,
      plannerReason: plan.reason,
      error: orchestrationError || null,
      contract: plan.contract,
      planApproval: plan.approval,
      semanticCheck,
      mailbox: mailbox.snapshot(),
      builders: builderResults.map((item) => ({
        id: item.id,
        title: item.title,
        agentId: item.agentId,
        status: item.status,
        writeScopes: item.writeScopes,
        contractKeys: item.contractKeys || [],
        changedPaths: item.changedPaths,
        handoff: item.handoff,
        summary: item.summary,
        error: item.error || null,
      })),
    },
    subagents: [
      ...(builderResults.map((item) => ({
        agentId: item.agentId,
        role: "builder",
        task: item.title,
        status: item.status,
        background: true,
      })) || []),
      ...(finalResult?.subagents || []),
    ],
  };

  const lifecycleType =
    status === "completed"
      ? "turn.completed"
      : status === "interrupted"
        ? "turn.cancelled"
        : "turn.failed";
  emit(
    {
      type: lifecycleType,
      status,
      changedFiles: combinedChanges.length,
      toolSteps: finalResult?.steps?.length || 0,
      orchestration: finalResult.orchestration,
    },
    { budgetEvent: false },
  );
  finalResult.witness = witness.snapshot();
  witness.dispose();
  return finalResult;
}

export async function runHarness(options = {}) {
  if (currentAgentBudget()) {
    return runOrchestratedHarness(options);
  }
  const budget = planAgentBudget(options);
  return runWithAgentBudget(budget, {}, () =>
    runOrchestratedHarness(options),
  );
}

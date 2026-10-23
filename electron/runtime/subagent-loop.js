import { TaskBrief } from "./task-brief.js";
import { createHash } from 'node:crypto';
import { DELEGATED_NATIVE_TOOLS, DELEGATED_WRITE_TOOLS, DELEGATED_COMMAND_TOOLS } from '../../shared/delegated-capabilities.js';
import { createBrowserRuntime } from '../browser-runtime.js';
import { acquireWorkbenchResources } from '../workbench/runtime-provider.js';
import { createPersistentProcessManager } from './process-runtime.js';
import { createLspManager } from './lsp-runtime.js';
import { appendBrowserVisualEvidence } from './browser-evidence.js';
import { WEB_TOOL_GUIDANCE } from './web-tools.js';
import { cloudWorkerDeferral } from "./cloud-wind-down.js";
import { applyRoleThinking } from './role-capabilities.js';
import { StrategyHistory } from "./strategy-history.js";
import { normalizeLoopPolicy } from "./completion-policy.js";
import { assistantHistoryMessage, harnessFeedback } from "./task-conversation.js";
import { completeLoopRequest } from "./loop-recovery.js";
import { LoopMetrics } from "./loop-metrics.js";
import { planToolBatches, executeToolBatch as mapWithConcurrency } from "./tool-batch.js";
import {
  getToolPermission,
} from '../agent-core.js';
import {
  compactConversationForRequest as compactManagedConversation,
  createTokenAccounting,
  estimateConversationTokens as estimateManagedConversationTokens,
  loadProjectInstructionContext,
  mergeTokenUsage,
  recordProviderUsage,
  resolveScopedInstructions,
  upsertRelevantContextMessage,
} from "../agent-context.js";
import { getDefaultAgentRuntimeBroker } from "../harness/agent-runtime-broker.js";
import { ToolProgressGuard } from "./tool-progress-guard.js";
import { searchProgressDetail } from './search-session.js';
import { dispatchNativeTool } from "./tool-dispatcher.js";
import { saveRuntimeCheckpoint, saveRuntimeContext, waitForRuntimeResume, isReadOnlyNativeTool } from "./durable-run.js";
import { modelReasoningParameters } from "../../shared/model-reasoning.js";
import { providerMessages } from "./task-conversation.js";
import { runIsolatedBuilder } from "./delegated-builder.js";
import { withAgentBudgetAdmission } from "../harness/agent-budget.js";
import { currentLocalControlPolicy, acquireLocalControlWorker, assertLocalControlTool, isLocalControlToolAvailable } from "../control/policy.js";
import { FINISH_SUBAGENT_TOOL, DELEGATION_CONTEXT_TOOL, readDelegationContext, readWorkerOutcome, syncDelegationContext, syncDependencyHandoff, noteDelegationRead, assertDelegationConstraintsRead } from './subagent-contract.js';
import {
  MAX_SUBAGENT_RESULT_CHARS,
  SUBAGENT_ROLE_CONFIG,
  assertSubagentRealScope,
  compactSubagentEvidence,
  compactSubagentModelResult,
  createSubagentPermissionPolicy,
  subagentEvidence,
  subagentToolPaths,
  subagentToolsAreParallel,
} from "./subagent-model.js";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const MAX_PARALLEL_TOOL_CALLS = 4;
const getRolePermissionDenied = (policy, name, mcp) => !mcp && (policy[name] ?? policy['*']) === 'deny';

function abortError() {
  const error = new Error("The run was interrupted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

export async function runSubagentTask(options = {}) {
  if (currentLocalControlPolicy() && !options.__localControlAdmitted) {
    const release = acquireLocalControlWorker({ agentId: options.agentId, role: options.input?.role });
    try { return await runSubagentTask({ ...options, __localControlAdmitted: true }); }
    finally { release(); }
  }
  await waitForRuntimeResume(options.signal);
  const deferred = cloudWorkerDeferral(options.provider);
  if (deferred) return { ...deferred, agentId: options.agentId, role: options.input?.role, evidence: [], steps: [], usage: null };
  if (!options.__budgetAdmitted) return withAgentBudgetAdmission({ role: options.input?.writeScopes?.length ? 'builder' : options.input?.role, signal: options.signal, systemOwned: options.systemOwned },
    () => runSubagentTask({ ...options, __budgetAdmitted: true }));
  const broker = getDefaultAgentRuntimeBroker();
  if (broker && options.__kernelRouted !== true) {
    return broker.run({
      agentId: options.agentId,
      role: options.input?.role,
      task: options.input?.task,
      background: options.input?.background,
      systemOwned: options.systemOwned,
      parentRunId: String(options.agentId || "").replace(/-sub-\d+$/, ""),
      emit: options.emit,
      signal: options.signal,
      continuation: Boolean(options.session?.conversation),
      definition: options.agentDefinition,
      execute: ({ definition }) =>
        runSubagentTask({
          ...options,
          __kernelRouted: true,
          agentDefinition: definition,
        }),
    });
  }

  const requestedModel = options.agentDefinition?.model;
  if (requestedModel && requestedModel !== "inherit" && requestedModel !== options.modelId && !options.__modelResolved) {
    if (typeof options.resolveModel !== "function") throw new Error(`SUBAGENT_MODEL_NOT_CONFIGURED: ${requestedModel}`);
    const resolved = await options.resolveModel(requestedModel);
    if (!resolved?.provider || !resolved?.modelId || !resolved?.modelConfig) throw new Error(`SUBAGENT_MODEL_NOT_CONFIGURED: ${requestedModel}`);
    return runSubagentTask({ ...options, ...resolved, __modelResolved: true });
  }
  if (!options.__thinkingResolved && options.input?.profile) {
    const policy = applyRoleThinking(options.input.profile, options.provider, options.modelId,
      { thinking: options.thinking, effort: options.effort });
    return runSubagentTask({ ...options, ...policy, __thinkingResolved: true });
  }
  const commandCandidates = ['run_command', 'verify_project', 'start_process'].some(name =>
    options.toolRegistry?.get?.(name) &&
    (!options.agentDefinition?.tools || options.agentDefinition.tools.includes(name)) &&
    getToolPermission(createSubagentPermissionPolicy(options.parentPermissionPolicy, options.input.role, options.agentDefinition), name) !== 'deny');
  if (!options.__builderIsolated && (options.input?.writeScopes?.length ||
      options.input?.commandScope === 'workspace' && commandCandidates)) return runIsolatedBuilder(options, runSubagentTask);
  const loopMetrics = new LoopMetrics();
  const originalEmit = options.emit;
  options = { ...options, emit: (event) => {
    loopMetrics.observe(event.type === "subagent.tool.started" ? { ...event, type: "tool.started" }
      : event.type === "subagent.tool.completed" ? { ...event, type: "tool.completed" } : event);
    originalEmit?.(event);
  } };
  const {
    agentId,
    input,
    provider,
    modelId,
    modelConfig,
    thinking,
    effort,
    workspaceRoot,
    parentPermissionPolicy,
    approvalMode,
    requestApproval,
    signal,
    sandboxExecutor,
    sandboxStatus,
    language,
    memoryFacts,
    emit,
    toolRegistry,
    parseToolArguments,
    executeAuthorizedTool,
    describeToolActivity,
    describeCapability,
    systemOwned = false,
    agentDefinition = null,
  } = options;

  if (!toolRegistry?.definitions) {
    throw new Error("Subagent loop requires the native tool registry.");
  }
  if (typeof parseToolArguments !== "function") {
    throw new Error("Subagent loop requires a tool argument parser.");
  }
  if (typeof executeAuthorizedTool !== "function") {
    throw new Error("Subagent loop requires the authorized tool executor.");
  }
  const activityFor =
    typeof describeToolActivity === "function"
      ? describeToolActivity
      : () => ({});
  const capabilityFor =
    typeof describeCapability === "function"
      ? describeCapability
      : () => null;
  const roleConfig = { ...SUBAGENT_ROLE_CONFIG[input.role], tools: new Set([
    ...DELEGATED_NATIVE_TOOLS,
    ...(agentDefinition?.tools || []).filter(name => ['search_skills', 'read_skill_resource', 'project_knowledge'].includes(name)),
  ]) };
  const runtimeDefinition = agentDefinition || null;
  const inheritedPolicy = createSubagentPermissionPolicy(
    parentPermissionPolicy,
    input.role,
    runtimeDefinition,
  );
  const permissionPolicy = Object.freeze({ ...inheritedPolicy,
    ...Object.fromEntries((input.writeScopes?.length ? [] : DELEGATED_WRITE_TOOLS).map(name => [name, 'deny'])),
    ...Object.fromEntries((input.commandScope === 'none' ? DELEGATED_COMMAND_TOOLS : []).map(name => [name, 'deny'])),
  });
  const definitionTools = Array.isArray(runtimeDefinition?.tools)
    ? new Set(runtimeDefinition.tools)
    : null;
  const enabledTools = toolRegistry
    .definitions(permissionPolicy)
    .filter(
      (definition) =>
        roleConfig.tools.has(definition.function.name) &&
        isLocalControlToolAvailable(definition.function.name) &&
        (!definitionTools || definitionTools.has(definition.function.name)),
    );
  enabledTools.push(FINISH_SUBAGENT_TOOL);
  enabledTools.push(DELEGATION_CONTEXT_TOOL);
  enabledTools.push(...(options.extensionDefinitions || []));
  const instructionContext = await loadProjectInstructionContext(workspaceRoot);
  const session = options.session || {};
  const contextCheckpoints = session.contextCheckpoints || [];
  const tokenAccounting = createTokenAccounting();
  tokenAccounting.providerOverheadTokens = estimateManagedConversationTokens([
    {
      role: "system",
      content: JSON.stringify(enabledTools),
    },
  ]);
  let usageTotal = null;
  const evidence = session.evidence || [];
  const toolSteps = session.steps || [];
  const initialConversation = [
    {
      role: "system",
      content: [
        `You are the AporiaX ${input.role} subagent.`,
        input.profile ? `Professional role: ${input.profile.name} (${input.profile.id}).` : '',
        runtimeDefinition?.description || roleConfig.description,
        runtimeDefinition?.systemPrompt || "",
        `Your delegated workspace scope is: ${input.scope.join(", ")}.`,
        `Command authority: ${input.commandScope || 'legacy-scope'}. Workspace command access does not broaden direct file-read/write scope and remains subject to parent approval/isolation.`,
        input.writeScopes?.length ? `Modify only these write scopes: ${input.writeScopes.join(', ')}. Changes are provisional until conflict-checked integration. Use authorized commands, browser checks and verify_project as needed. A Git worktree is NOT an OS or network sandbox. Host execution follows the parent's approval policy; never bypass it or claim isolation. Do not recursively delegate or publish.` : 'No native file-write scope was delegated. Authorized commands use a private workspace; any resulting changes are attributed to you and conflict-checked before integration, not written directly to shared source. Use commands for the assigned purpose, not to evade the assignment. A workspace copy is not an OS sandbox.',
        "Work independently and return a concise evidence-backed report to the parent agent.",
        input.context ? `Main's concise handoff (advisory, not authorization or proof; verify current files):\n${input.context}` : '',
        "Use task_brief for durable concise decisions and replan_strategy with fresh diagnostics when repeated failures require a different approach. These do not grant extra permissions.",
        "Use workspace-relative paths. Do not claim anything you did not verify with tools.",
        enabledTools.some(tool => tool.function.name === 'web_search') ? WEB_TOOL_GUIDANCE : '',
        "Do not expose hidden reasoning. Report conclusions, evidence, commands, and uncertainty only.",
        "Use finish_subagent alone to report completed, partial, blocked or needs_input. Execution completion is not parent acceptance or proof of verification. Inherited user requirements take precedence over Main's paraphrase; report conflicts without broadening scope.",
        instructionContext.root.content
          ? `Project instructions:\n${instructionContext.root.content}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    { role: "user", content: input.task, aporiaSource: 'delegation', aporiaPinned: true },
  ];
  const conversation = session.conversation || initialConversation;
  if (session.conversation) {
    // Refresh only the trusted runtime prompt. Preserve assignments, original
    // requirements, tool receipts and project/scoped instructions after it.
    if (conversation[0]?.role === 'system') conversation[0] = initialConversation[0];
    else conversation.unshift(initialConversation[0]);
  }
  // Migrate resumed workers from the old fixed-prefix memory injection.
  if (conversation[0]?.role === "system" && typeof conversation[0].content === "string") {
    conversation[0].content = conversation[0].content.replace(/\nRelevant project memory:\n[\s\S]*$/, "");
  }
  const brief = new TaskBrief(session.taskBrief, { resumed: Boolean(session.taskBrief) });
  const loopPolicy = normalizeLoopPolicy(options.loopPolicy);
  const toolProgress = new ToolProgressGuard({ maxRepeatedEvidence: loopPolicy.maxRepeatedEvidence, snapshot: session.toolProgress });
  const strategy = new StrategyHistory(session.strategyHistory, { mode: loopPolicy.strategyMode, maxInterventions: loopPolicy.maxStrategyInterventions });
  brief.syncSources(conversation);
  Object.assign(session, { conversation, contextCheckpoints, evidence, steps: toolSteps });
  const persistSession = async (status = "running", result = null, { snapshot = false } = {}) => {
    session.taskBrief = brief.snapshot(); session.strategyHistory = strategy.snapshot(); session.toolProgress = toolProgress.snapshot();
    // Reads, model waits and bookkeeping cannot change the isolated workspace.
    // Snapshot after every potentially effectful tool (even failed tools), and
    // at terminal boundaries. The Builder wrapper also scans before integration.
    if (snapshot || status !== "running") {
      await options.snapshotProvisional?.();
      if (options.snapshotProvisional) session.workspaceEvidenceVersion = createHash('sha256').update(JSON.stringify(
        (session.provisionalChanges || []).map(change => [change.path, change.beforeHash, change.afterHash]))).digest('hex');
    }
    await saveRuntimeContext(agentId, {
      kind: "worker", workspaceRoot: options.ownerWorkspaceRoot || workspaceRoot, input, session, status, result,
    });
  };
  const contextWindowTokens = Math.max(
    32_000,
    Number(modelConfig.contextWindow || DEFAULT_CONTEXT_WINDOW_TOKENS),
  );
  session.activationSequence = (session.activationSequence || 0) + 1;
  const activationId = `${agentId}:${session.activationSequence}`;
  const refreshInheritedContext = async () => {
    syncDependencyHandoff(conversation, session.dependencyHandoff);
    const context = options.getDelegationContext ? await options.getDelegationContext() : session.delegationContext;
    if (context) { session.delegationContext = context; return syncDelegationContext(conversation, context, { contextWindowTokens }); }
    return false;
  };
  await refreshInheritedContext();

  emit({
    type: "subagent.started",
    activationId,
    agentId,
    role: input.role,
    task: input.task,
    scope: input.scope,
    background: input.background,
    systemOwned,
    runtime: runtimeDefinition ? "kernel" : "compatibility",
  });
  const wireReasoning = modelReasoningParameters(provider, { modelId, thinking, effort });
  emit({ type: "subagent.configured", agentId, role: input.role, provider: provider.id, model: modelId,
    profileId: input.profileId, profileName: input.profile?.name,
    thinking: Boolean(wireReasoning.reasoning_effort || wireReasoning.thinking?.type === 'enabled'), effort: wireReasoning.reasoning_effort || null,
    permissions: permissionPolicy, tools: enabledTools.map((tool) => tool.function.name), maxRounds: null });

  const resources = acquireWorkbenchResources({ runId: agentId, taskId: options.taskId || agentId,
    workspacePath: options.ownerWorkspaceRoot || workspaceRoot, ownerId: agentId, emit });
  const workerBrowser = resources?.browserRuntime || createBrowserRuntime();
  const workerProcesses = resources?.processManager || createPersistentProcessManager({ emit });
  const workerLsp = createLspManager({ workspaceRoot, emit, signal });
  let terminalResult = null;
  try {
    for (let round = 1; ; round += 1) {
      throwIfAborted(signal);
      options.assertDependencies?.();
      await refreshInheritedContext();
      if (options.getExtensionDefinitions) {
        const next = options.getExtensionDefinitions();
        const oldNames = new Set((options.extensionDefinitions || []).map(def => def.function.name));
        for (let i = enabledTools.length - 1; i >= 0; i--) if (oldNames.has(enabledTools[i].function.name)) enabledTools.splice(i, 1);
        options.extensionDefinitions = next;
        enabledTools.push(...next);
      }
      if (session.pendingGuidance?.length) {
        toolProgress.reset(); strategy.reset();
        conversation.push(...session.pendingGuidance.splice(0).map((content) => ({ role: 'user', content, aporiaSource: 'delegation', aporiaPinned: true })));
      }
      // Repetition and strategy failures are local tool receipts, not a stop gate.
      brief.syncSources(conversation);
      brief.inject(conversation, { strategy: strategy.briefing() });
      await saveRuntimeCheckpoint({ scopeId: agentId, role: input.role, task: input.task, workspaceRoot, status: "running", round, evidence: compactSubagentEvidence(evidence) });
      const relevant = upsertRelevantContextMessage(conversation, {
        checkpoints: contextCheckpoints,
        memoryFacts: options.getMemoryFacts ? await options.getMemoryFacts() : memoryFacts,
      });
      compactManagedConversation({
        conversation,
        onEvent: (event) => {
          loopMetrics.observe(event);
          emit({ ...event, type: "subagent.context.compacted", agentId });
        },
        contextCheckpoints,
        contextWindowTokens,
        accounting: tokenAccounting,
        relevantMemory: relevant,
      });
      await appendBrowserVisualEvidence(conversation, { supportsImages: provider.supportsImages, providerId: provider.id, modelId, signal });
      session.roleRounds = (session.roleRounds || 0) + 1;
      await persistSession();
      const completion = await completeLoopRequest({ conversation, contextCheckpoints,
        accounting: tokenAccounting, contextWindowTokens, signal, persist: persistSession, scopeId: agentId,
        shouldYield: () => Boolean(session.pendingGuidance?.length),
        onEvent: (event) => { loopMetrics.observe(event); emit({ ...event, type: `subagent.${event.type}`, agentId }); },
        onFailedUsage: async (usage) => { usageTotal = mergeTokenUsage(usageTotal, usage); options.onUsage?.(usage); await persistSession(); },
        getBody: (requestMessages) => ({
          model: modelId,
          messages: providerMessages(requestMessages),
          ...(provider.supportsTools && enabledTools.length
            ? { tools: enabledTools, tool_choice: "auto" }
            : {}),
          ...modelReasoningParameters(provider, { modelId, thinking, effort }),
        }),
        complete: async (body, requestSignal = signal) => {
          loopMetrics.request(body);
          return provider.complete({ signal: requestSignal, body, requestTrace: { agentId }, onStreamEvent: (event) => {
            loopMetrics.observe(event);
            if (event.type === "response.activity") emit({ type: "subagent.activity", agentId, role: input.role });
            if (["response.progress", "response.recovery.status", "response.cloud.queued", "response.cloud.admitted"].includes(event.type)) emit({ ...event, type: `subagent.${event.type}`, agentId, role: input.role });
            if (event.type === "response.attempt.completed") emit({ ...event, type: "subagent.response.attempt.completed", agentId });
          } });
        },
      });
      let { message } = completion;
      const { usage, requestConversation } = completion;
      recordProviderUsage(tokenAccounting, usage, requestConversation);
      usageTotal = mergeTokenUsage(usageTotal, completion.attemptUsage || usage);
      options.onUsage?.(completion.attemptUsage || usage);
      // Steering discards obsolete actions, not the usage already incurred to
      // generate them. Failed attempts are accounted separately by the callback.
      if (completion.interrupted) continue;
      throwIfAborted(signal);
      // A user may steer the parent while a worker is waiting for its model.
      // Discard that stale action proposal before it can perform side effects.
      if (await refreshInheritedContext()) continue;
      let outcome;
      try { outcome = readWorkerOutcome(message, parseToolArguments); }
      catch (error) {
        toolProgress.observe({ tool: 'invalid_worker_outcome', input: {}, result: { error: error.message } });
        conversation.push(assistantHistoryMessage(message));
        for (const call of message.tool_calls || []) conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: error.message, executed: false }) });
        continue;
      }
      if (outcome) {
        await assertLocalControlTool({ toolName: "finish_subagent", input: outcome, workspaceRoot });
        conversation.push(assistantHistoryMessage(message));
        conversation.push({ role: 'tool', tool_call_id: outcome.call.id, content: JSON.stringify({ recorded: true, accepted: false }) });
        message = { role: 'assistant', content: outcome.summary };
      }
      const issuedContextRevision = session.delegationContext?.revision;
      if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) {
        if (typeof message.content !== "string" || !message.content.trim()) throw new Error("MODEL_EMPTY_RESPONSE: subagent returned no evidence or report.");
        if (session.pendingGuidance?.length) {
          conversation.push(assistantHistoryMessage(message));
          continue;
        }
        const summary = String(message.content || "")
          .trim()
          .slice(0, MAX_SUBAGENT_RESULT_CHARS);
        const result = {
          agentId,
          role: input.role,
          status: outcome?.status || 'completed',
          reportId: activationId,
          acceptance: { status: systemOwned ? 'consumer_review' : 'pending', certification: 'not-verified' },
          summary:
            summary ||
            (language === "en"
              ? "The subagent completed without a textual report."
              : "子 Agent 已完成，但没有返回文本报告。"),
          evidence: compactSubagentEvidence(evidence),
          steps: toolSteps.slice(-60),
          usage: usageTotal, loopMetrics: loopMetrics.snapshot(), taskBrief: brief.snapshot(), strategy: strategy.briefing(),
          rounds: round,
          instructionFiles: [...instructionContext.loadedFiles],
        };
        conversation.push(assistantHistoryMessage(message));
        await persistSession(result.status, result);
        await saveRuntimeCheckpoint({ scopeId: agentId, ...result });
        emit({
          type: "subagent.completed",
          activationId,
          acceptance: result.acceptance,
          agentId,
          role: input.role,
          status: result.status,
          rounds: round,
          toolSteps: toolSteps.length,
          summary: result.summary.slice(0, 500),
          systemOwned,
          runtime: runtimeDefinition ? "kernel" : "compatibility",
        });
        terminalResult = result;
        return result;
      }

      conversation.push({
        role: "assistant",
        content: message.content ?? null,
        ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
        ...(message.aporiaNative ? { aporiaNative: message.aporiaNative } : {}),
        tool_calls: message.tool_calls,
      });
      await persistSession();
      for (const batch of planToolBatches(message.tool_calls,
        (call) => subagentToolsAreParallel([call, call]))) {
      const parallelBatch = batch.parallel;
      const executeCall = async (toolCall) => {
        await waitForRuntimeResume(signal);
        const toolName = toolCall.function.name;
        const capabilityPhase = ["review", "verify"].includes(input.role)
          ? "self-check"
          : "work";
        const capability = capabilityFor(toolName, capabilityPhase);
        let modelResult, appliedChanges = [];
        let success = true;
        emit({
          type: "subagent.tool.started",
          agentId,
          callId: toolCall.id,
          role: input.role,
          tool: toolName,
          capability,
          parallel: parallelBatch,
          ...activityFor(toolCall),
        });
        try {
          options.assertDependencies?.();
          await refreshInheritedContext();
          if (session.pendingGuidance?.length) throw new Error('SUBAGENT_GUIDANCE_CHANGED: additional instructions arrived; skip stale actions and replan.');
          if (session.delegationContext?.revision !== issuedContextRevision) throw new Error('SUBAGENT_GUIDANCE_CHANGED: action skipped; replan using updated user requirements.');
          const extension = options.extensionDefinitions?.some(def => def.function.name === toolName);
          if (!roleConfig.tools.has(toolName) && !extension && toolName !== 'read_delegation_context') {
            throw new Error(`Tool is not available to ${input.role}: ${toolName}`);
          }
          if (definitionTools && !definitionTools.has(toolName) && !extension && toolName !== 'read_delegation_context') {
            throw new Error(`Tool is not enabled by Agent Registry for ${input.role}: ${toolName}`);
          }
          const parsedInput = parseToolArguments(toolCall);
          toolProgress.before(toolName, parsedInput, session.workspaceEvidenceVersion || '');
          const roleExtension = extension || ['search_skills', 'read_skill_resource', 'project_knowledge'].includes(toolName);
          if (toolName === 'read_delegation_context') {
            await assertLocalControlTool({ toolName, input: parsedInput, workspaceRoot });
            modelResult = readDelegationContext(session.delegationContext, parsedInput);
            noteDelegationRead(session, modelResult);
          }
          else if (roleExtension) {
            assertDelegationConstraintsRead(conversation, session);
            if (getRolePermissionDenied(permissionPolicy, toolName, extension)) throw new Error(`Permission denied for tool: ${toolName}`);
            const result = await options.executeRoleExtension?.({ toolName, input: parsedInput, signal, agentId, requestApproval, workspaceRoot });
            if (result === undefined) throw new Error('Role extension is unavailable.');
            modelResult = compactSubagentModelResult(result);
          } else {
          strategy.before(toolName, parsedInput);
          if (!isReadOnlyNativeTool(toolName)) assertDelegationConstraintsRead(conversation, session);
          await assertSubagentRealScope(toolName, parsedInput, DELEGATED_WRITE_TOOLS.includes(toolName) ? (input.writeScopes || []) : input.scope, workspaceRoot, input.commandScope);
          const scoped = ["task_brief", "replan_strategy"].includes(toolName) ? {} : await resolveScopedInstructions(
            instructionContext,
            subagentToolPaths(toolName, parsedInput),
          );
          if (scoped.content) {
            conversation.splice(1, 0, {
              role: "system",
              content: `Scoped project instructions for this subagent:\n${scoped.content}`,
            });
            emit({
              type: "subagent.instructions.loaded",
              agentId,
              files: scoped.files,
            });
            if (toolName === "run_command") {
              throw new Error(
                `Scoped project instructions were loaded from ${scoped.files.join(", ")}. Review them, then retry the verification command if it remains appropriate.`,
              );
            }
          }
          const executed = await dispatchNativeTool({
            toolCall,
            registry: toolRegistry,
            permissionPolicy,
            approvalMode,
            requestApproval,
            sandboxStatus,
            signal,
            parseArguments: parseToolArguments,
            executeAuthorized: ["task_brief", "replan_strategy"].includes(toolName)
              ? async ({ input }) => ({ modelResult: toolName === "task_brief" ? brief.apply(input) : strategy.replan(input) })
              : executeAuthorizedTool,
            executeContext: {
              workspaceRoot,
              sandboxExecutor,
              sandboxStatus,
              browserRuntime: workerBrowser,
              processManager: workerProcesses,
              lspManager: workerLsp,
              workbenchPresent: resources?.present || null,
              dependencyWorkspaceRoot: options.ownerWorkspaceRoot || workspaceRoot,
              durableScope: agentId,
              onSearchProgress: progress => emit({ type: 'subagent.tool.progress', agentId,
                tool: toolName, callId: toolCall.id, detail: searchProgressDetail(progress, options.language) }),
            },
          });
          appliedChanges = executed.changes || (executed.change ? [executed.change] : []);
          modelResult = compactSubagentModelResult(executed.modelResult);
          }
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          success = false;
          modelResult = { error: error.message };
        }
        let observedInput;
        try { observedInput = parseToolArguments(toolCall); } catch { observedInput = {}; }
        brief.observe({ callId: toolCall.id, tool: toolName, input: observedInput, result: modelResult, version: "worker-current" });
        strategy.observe({ callId: toolCall.id, tool: toolName, input: observedInput, result: modelResult, changes: appliedChanges });
        const item = { ...subagentEvidence(toolName, modelResult), evidenceId: `${activationId}:${toolCall.id}`, callId: toolCall.id };
        evidence.push(item);
        toolSteps.push({
          name: toolName,
          success,
          path: item.path,
          command: item.command,
          exitCode: item.exitCode,
          detail: item.error || null,
        });
        emit({
          type: "subagent.tool.completed",
          agentId,
          callId: toolCall.id,
          role: input.role,
          tool: toolName,
          parallel: parallelBatch,
          success,
          path: item.path,
          command: item.command,
          exitCode: item.exitCode,
          detail: item.error || item.preview,
        });
        // Builder edits reach durable storage at each tool boundary, not only
        // after its model eventually produces a final answer.
        if (options.snapshotProvisional) await persistSession('running', null, {
          snapshot: appliedChanges.length > 0 || !isReadOnlyNativeTool(toolName)
            || options.extensionDefinitions?.some(def => def.function.name === toolName),
        });
        return { toolCall, modelResult };
      };
      const results = await mapWithConcurrency(batch.calls,
        parallelBatch ? MAX_PARALLEL_TOOL_CALLS : 1, executeCall, { signal });
      for (const { toolCall, modelResult } of results) {
        let parsed;
        try { parsed = parseToolArguments(toolCall); } catch { parsed = toolCall.function.arguments; }
        const warning = toolProgress.observe({ tool: toolCall.function.name, input: parsed, result: modelResult, version: session.workspaceEvidenceVersion || '' });
        if (warning) {
          modelResult.progressWarning = warning;
          emit({ type: "runtime.no_progress.warning", agentId, tool: toolCall.function.name, message: warning });
        }
        conversation.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(modelResult),
        });
      }
      await persistSession();
      } // contiguous tool batches
    }

  } catch (error) {
    if (error?.name === "AbortError") {
      await persistSession("interrupted");
      emit({ type: "subagent.cancelled", activationId, agentId, role: input.role, systemOwned });
      // A cancelled optional worker can have completed billable rounds.
      error.usage = usageTotal;
      error.evidence = compactSubagentEvidence(evidence);
      error.steps = toolSteps.slice(-60);
      throw error;
    }
    const result = {
      agentId,
      role: input.role,
      status: 'failed',
      reportId: activationId,
      acceptance: { status: systemOwned ? 'consumer_review' : 'pending', certification: 'not-verified' },
      summary: error.message,
      evidence: compactSubagentEvidence(evidence),
      steps: toolSteps.slice(-60),
      usage: usageTotal, loopMetrics: loopMetrics.snapshot(), taskBrief: brief.snapshot(), strategy: strategy.briefing(),
    };
    await saveRuntimeCheckpoint({ scopeId: agentId, ...result });
    await persistSession(result.status, result);
    emit({
      type: 'subagent.failed',
      activationId,
      acceptance: result.acceptance,
      agentId,
      role: input.role,
      error: error.message,
      systemOwned,
      runtime: runtimeDefinition ? "kernel" : "compatibility",
    });
    terminalResult = result;
    return result;
  } finally {
    const cleanupWarnings = [];
    const clean = async operation => { try { await operation(); } catch (error) { cleanupWarnings.push(String(error.message || error)); } };
    await clean(() => workerLsp.closeAll());
    if (resources) await clean(() => resources.release({ aborted: Boolean(signal?.aborted) }));
    else { await clean(() => workerBrowser.close()); await clean(() => workerProcesses.closeAll()); }
    if (cleanupWarnings.length) {
      if (terminalResult) terminalResult.cleanupWarnings = cleanupWarnings;
      emit({ type: 'subagent.resource.warning', agentId, role: input.role, warnings: cleanupWarnings,
        detail: cleanupWarnings.join('; '), recoverable: true });
      // Resource disposal is not an implementation failure. Retain the report
      // even when its warning cannot be persisted during shutdown.
      if (terminalResult) await persistSession(terminalResult.status, terminalResult).catch(() => {});
    }
  }
}

import { TaskBrief } from "./task-brief.js";
import { StrategyHistory } from "./strategy-history.js";
import { normalizeLoopPolicy } from "./completion-policy.js";
import { assistantHistoryMessage } from "./task-conversation.js";
import { completeLoopRequest } from "./loop-recovery.js";
import { LoopMetrics } from "./loop-metrics.js";
import { planToolBatches, executeToolBatch as mapWithConcurrency } from "./tool-batch.js";
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
import { dispatchNativeTool } from "./tool-dispatcher.js";
import { saveRuntimeCheckpoint, saveRuntimeContext, waitForRuntimeResume } from "./durable-run.js";
import { providerMessages } from "./task-conversation.js";
import { runIsolatedBuilder } from "./delegated-builder.js";
import { withAgentBudgetAdmission } from "../harness/agent-budget.js";
import { FINISH_SUBAGENT_TOOL, readWorkerOutcome, syncDelegationContext } from './subagent-contract.js';
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

function abortError() {
  const error = new Error("The run was interrupted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

export async function runSubagentTask(options = {}) {
  await waitForRuntimeResume(options.signal);
  if (!options.__budgetAdmitted) return withAgentBudgetAdmission({ role: options.input?.role, signal: options.signal, systemOwned: options.systemOwned },
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
  if (options.input?.role === "builder" && !options.__builderIsolated) return runIsolatedBuilder(options, runSubagentTask);
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
  const roleConfig = SUBAGENT_ROLE_CONFIG[input.role];
  const runtimeDefinition = agentDefinition || null;
  const permissionPolicy = createSubagentPermissionPolicy(
    parentPermissionPolicy,
    input.role,
    runtimeDefinition,
  );
  const definitionTools = Array.isArray(runtimeDefinition?.tools)
    ? new Set(runtimeDefinition.tools)
    : null;
  const enabledTools = toolRegistry
    .definitions(permissionPolicy)
    .filter(
      (definition) =>
        roleConfig.tools.has(definition.function.name) &&
        (!definitionTools || definitionTools.has(definition.function.name)),
    );
  enabledTools.push(FINISH_SUBAGENT_TOOL);
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
  const effectiveMaxRounds = Math.min(
    input.maxRounds,
    Math.max(2, Number(runtimeDefinition?.maxRounds || input.maxRounds)),
  );
  const conversation = session.conversation || [
    {
      role: "system",
      content: [
        `You are the AporiaX ${input.role} subagent.`,
        runtimeDefinition?.description || roleConfig.description,
        runtimeDefinition?.systemPrompt || "",
        `Your delegated workspace scope is: ${input.scope.join(", ")}.`,
        ...(input.role === "builder" ? [`Modify only these write scopes: ${input.writeScopes.join(", ")}. Changes are provisional until the Harness merges them. Do not run commands, delegate, or publish. Report unverified checks to the parent.`] : []),
        "Work independently and return a concise evidence-backed report to the parent agent.",
        "Use task_brief for durable concise decisions and replan_strategy with fresh diagnostics when repeated failures require a different approach. These do not grant extra permissions.",
        "Use workspace-relative paths. Do not claim anything you did not verify with tools.",
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
  // Migrate resumed workers from the old fixed-prefix memory injection.
  if (conversation[0]?.role === "system" && typeof conversation[0].content === "string") {
    conversation[0].content = conversation[0].content.replace(/\nRelevant project memory:\n[\s\S]*$/, "");
  }
  const brief = new TaskBrief(session.taskBrief, { resumed: Boolean(session.taskBrief) });
  const loopPolicy = normalizeLoopPolicy(options.loopPolicy);
  const strategy = new StrategyHistory(session.strategyHistory, { mode: loopPolicy.strategyMode, maxInterventions: loopPolicy.maxStrategyInterventions });
  brief.syncSources(conversation);
  Object.assign(session, { conversation, contextCheckpoints, evidence, steps: toolSteps });
  const persistSession = async (status = "running", result = null) => {
    session.taskBrief = brief.snapshot(); session.strategyHistory = strategy.snapshot();
    await options.snapshotProvisional?.();
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
    const context = options.getDelegationContext ? await options.getDelegationContext() : session.delegationContext;
    if (context) { session.delegationContext = context; return syncDelegationContext(conversation, context); }
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
  emit({ type: "subagent.configured", agentId, role: input.role, provider: provider.id, model: modelId,
    permissions: permissionPolicy, tools: enabledTools.map((tool) => tool.function.name), maxRounds: effectiveMaxRounds });

  const toolProgress = new ToolProgressGuard();
  try {
    for (let round = 1; round <= effectiveMaxRounds; round += 1) {
      throwIfAborted(signal);
      await refreshInheritedContext();
      if (session.pendingGuidance?.length) {
        toolProgress.reset(); strategy.reset();
        conversation.push(...session.pendingGuidance.splice(0).map((content) => ({ role: 'user', content, aporiaSource: 'delegation', aporiaPinned: true })));
      }
      strategy.assertBudget();
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
          ...(provider.supportsThinking &&
          provider.thinkingMode === "deepseek"
            ? {
                thinking: { type: thinking ? "enabled" : "disabled" },
                ...(thinking
                  ? {
                      reasoning_effort:
                        effort === "max" ? "max" : "high",
                    }
                  : {}),
              }
            : {}),
          ...(provider.supportsThinking &&
          provider.thinkingMode === "reasoning-effort" &&
          thinking
            ? { reasoning_effort: effort === "max" ? "high" : "medium" }
            : {}),
        }),
        complete: async (body, requestSignal = signal) => {
          loopMetrics.request(body);
          return provider.complete({ signal: requestSignal, body, onStreamEvent: (event) => {
            loopMetrics.observe(event);
            if (event.type === "response.activity") emit({ type: "subagent.activity", agentId, role: input.role });
            if (event.type === "response.attempt.completed") emit({ ...event, type: "subagent.response.attempt.completed", agentId });
          } });
        },
      });
      let { message } = completion;
      const { usage, requestConversation } = completion;
      if (completion.interrupted) continue;
      recordProviderUsage(tokenAccounting, usage, requestConversation);
      usageTotal = mergeTokenUsage(usageTotal, completion.attemptUsage || usage);
      options.onUsage?.(completion.attemptUsage || usage);
      // A user may steer the parent while a worker is waiting for its model.
      // Discard that stale action proposal before it can perform side effects.
      if (await refreshInheritedContext()) continue;
      let outcome;
      try { outcome = readWorkerOutcome(message, parseToolArguments); }
      catch (error) {
        conversation.push(assistantHistoryMessage(message));
        for (const call of message.tool_calls || []) conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: error.message, executed: false }) });
        continue;
      }
      if (outcome) {
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
          status: outcome?.status || "completed",
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
          await refreshInheritedContext();
          if (session.delegationContext?.revision !== issuedContextRevision) throw new Error('SUBAGENT_GUIDANCE_CHANGED: action skipped; replan using updated user requirements.');
          if (!roleConfig.tools.has(toolName)) {
            throw new Error(`Tool is not available to ${input.role}: ${toolName}`);
          }
          if (definitionTools && !definitionTools.has(toolName)) {
            throw new Error(`Tool is not enabled by Agent Registry for ${input.role}: ${toolName}`);
          }
          const parsedInput = parseToolArguments(toolCall);
          strategy.before(toolName, parsedInput);
          await assertSubagentRealScope(toolName, parsedInput, input.role === "builder" && ["write_file", "apply_patch"].includes(toolName) ? input.writeScopes : input.scope, workspaceRoot);
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
              durableScope: agentId,
            },
          });
          appliedChanges = executed.changes || (executed.change ? [executed.change] : []);
          modelResult = compactSubagentModelResult(executed.modelResult);
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
        if (input.role === "builder") await persistSession();
        return { toolCall, modelResult };
      };
      const results = await mapWithConcurrency(batch.calls,
        parallelBatch ? MAX_PARALLEL_TOOL_CALLS : 1, executeCall, { signal });
      for (const { toolCall, modelResult } of results) {
        let parsed;
        try { parsed = parseToolArguments(toolCall); } catch { parsed = toolCall.function.arguments; }
        const warning = toolProgress.observe({ tool: toolCall.function.name, input: parsed, result: modelResult });
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

    const result = {
      agentId,
      role: input.role,
      status: "budget_exhausted",
      reportId: activationId,
      acceptance: { status: systemOwned ? 'consumer_review' : 'pending', certification: 'not-verified' },
      summary:
        language === "en"
          ? `The subagent reached its ${effectiveMaxRounds}-round safety budget. Use its evidence as partial results or delegate a narrower follow-up.`
          : `子 Agent 已达到 ${effectiveMaxRounds} 轮安全预算。请把现有证据视为部分结果，或委派一个范围更小的后续任务。`,
      evidence: compactSubagentEvidence(evidence),
      steps: toolSteps.slice(-60),
      usage: usageTotal, loopMetrics: loopMetrics.snapshot(), taskBrief: brief.snapshot(), strategy: strategy.briefing(),
      rounds: effectiveMaxRounds,
      instructionFiles: [...instructionContext.loadedFiles],
    };
    await saveRuntimeCheckpoint({ scopeId: agentId, ...result });
    await persistSession("budget_exhausted", result);
    emit({
      type: "subagent.completed",
      activationId,
      acceptance: result.acceptance,
      agentId,
      role: input.role,
      status: result.status,
      rounds: result.rounds,
      toolSteps: toolSteps.length,
      summary: result.summary,
      systemOwned,
      runtime: runtimeDefinition ? "kernel" : "compatibility",
    });
    return result;
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
      status: "failed",
      reportId: activationId,
      acceptance: { status: systemOwned ? 'consumer_review' : 'pending', certification: 'not-verified' },
      summary: error.message,
      evidence: compactSubagentEvidence(evidence),
      steps: toolSteps.slice(-60),
      usage: usageTotal, loopMetrics: loopMetrics.snapshot(), taskBrief: brief.snapshot(), strategy: strategy.briefing(),
    };
    await saveRuntimeCheckpoint({ scopeId: agentId, ...result });
    await persistSession("failed", result);
    emit({
      type: "subagent.failed",
      activationId,
      acceptance: result.acceptance,
      agentId,
      role: input.role,
      error: error.message,
      systemOwned,
      runtime: runtimeDefinition ? "kernel" : "compatibility",
    });
    return result;
  }
}

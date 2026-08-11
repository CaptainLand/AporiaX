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
import { dispatchNativeTool } from "./tool-dispatcher.js";
import {
  MAX_SUBAGENT_RESULT_CHARS,
  SUBAGENT_ROLE_CONFIG,
  assertSubagentScope,
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

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export async function runSubagentTask({
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
}) {
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
  const permissionPolicy = createSubagentPermissionPolicy(
    parentPermissionPolicy,
    input.role,
  );
  const enabledTools = toolRegistry
    .definitions(permissionPolicy)
    .filter((definition) => roleConfig.tools.has(definition.function.name));
  const instructionContext = await loadProjectInstructionContext(workspaceRoot);
  const contextCheckpoints = [];
  const tokenAccounting = createTokenAccounting();
  tokenAccounting.providerOverheadTokens = estimateManagedConversationTokens([
    {
      role: "system",
      content: JSON.stringify(enabledTools),
    },
  ]);
  let usageTotal = null;
  const evidence = [];
  const toolSteps = [];
  const conversation = [
    {
      role: "system",
      content: [
        `You are the AporiaX ${input.role} subagent.`,
        roleConfig.description,
        `Your delegated workspace scope is: ${input.scope.join(", ")}.`,
        "Work independently and return a concise evidence-backed report to the parent agent.",
        "Use workspace-relative paths. Do not claim anything you did not verify with tools.",
        "Do not expose hidden reasoning. Report conclusions, evidence, commands, and uncertainty only.",
        instructionContext.root.content
          ? `Project instructions:\n${instructionContext.root.content}`
          : "",
        memoryFacts?.length
          ? `Relevant project memory:\n${JSON.stringify(memoryFacts.slice(0, 10))}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    { role: "user", content: input.task },
  ];
  const contextWindowTokens = Math.max(
    32_000,
    Number(modelConfig.contextWindow || DEFAULT_CONTEXT_WINDOW_TOKENS),
  );

  emit({
    type: "subagent.started",
    agentId,
    role: input.role,
    task: input.task,
    scope: input.scope,
    background: input.background,
  });

  try {
    for (let round = 1; round <= input.maxRounds; round += 1) {
      throwIfAborted(signal);
      const relevant = upsertRelevantContextMessage(conversation, {
        checkpoints: contextCheckpoints,
        memoryFacts,
      });
      compactManagedConversation({
        conversation,
        onEvent: (event) =>
          emit({ ...event, type: "subagent.context.compacted", agentId }),
        contextCheckpoints,
        contextWindowTokens,
        accounting: tokenAccounting,
        relevantMemory: relevant,
      });
      const requestConversation = conversation;
      const { message, usage } = await provider.complete({
        signal,
        onStreamEvent: () => undefined,
        body: {
          model: modelId,
          messages: requestConversation,
          ...(provider.supportsTools && enabledTools.length
            ? { tools: enabledTools, tool_choice: "auto" }
            : {}),
          ...(provider.supportsThinking &&
          provider.thinkingMode === "deepseek"
            ? {
                thinking: { type: thinking ? "enabled" : "disabled" },
                reasoning_effort: effort === "max" ? "max" : "high",
              }
            : {}),
          ...(provider.supportsThinking &&
          provider.thinkingMode === "reasoning-effort" &&
          thinking
            ? { reasoning_effort: effort === "max" ? "high" : "medium" }
            : {}),
        },
      });
      recordProviderUsage(tokenAccounting, usage, requestConversation);
      usageTotal = mergeTokenUsage(usageTotal, usage);
      if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) {
        const summary = String(message.content || "")
          .trim()
          .slice(0, MAX_SUBAGENT_RESULT_CHARS);
        const result = {
          agentId,
          role: input.role,
          status: "completed",
          summary:
            summary ||
            (language === "en"
              ? "The subagent completed without a textual report."
              : "子 Agent 已完成，但没有返回文本报告。"),
          evidence: compactSubagentEvidence(evidence),
          steps: toolSteps.slice(-60),
          usage: usageTotal,
          rounds: round,
          instructionFiles: [...instructionContext.loadedFiles],
        };
        emit({
          type: "subagent.completed",
          agentId,
          role: input.role,
          status: result.status,
          rounds: round,
          toolSteps: toolSteps.length,
          summary: result.summary.slice(0, 500),
        });
        return result;
      }

      conversation.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.tool_calls,
      });
      const parallelBatch = subagentToolsAreParallel(message.tool_calls);
      const executeCall = async (toolCall) => {
        const toolName = toolCall.function.name;
        const capabilityPhase = ["review", "verify"].includes(input.role)
          ? "self-check"
          : "work";
        const capability = capabilityFor(toolName, capabilityPhase);
        let modelResult;
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
          if (!roleConfig.tools.has(toolName)) {
            throw new Error(`Tool is not available to ${input.role}: ${toolName}`);
          }
          const parsedInput = parseToolArguments(toolCall);
          assertSubagentScope(toolName, parsedInput, input.scope);
          const scoped = await resolveScopedInstructions(
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
            executeAuthorized: executeAuthorizedTool,
            executeContext: {
              workspaceRoot,
              sandboxExecutor,
              sandboxStatus,
            },
          });
          modelResult = compactSubagentModelResult(executed.modelResult);
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          success = false;
          modelResult = { error: error.message };
        }
        const item = subagentEvidence(toolName, modelResult);
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
        return { toolCall, modelResult };
      };
      const results = parallelBatch
        ? await mapWithConcurrency(
            message.tool_calls,
            MAX_PARALLEL_TOOL_CALLS,
            executeCall,
          )
        : await mapWithConcurrency(message.tool_calls, 1, executeCall);
      for (const { toolCall, modelResult } of results) {
        conversation.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(modelResult),
        });
      }
    }

    const result = {
      agentId,
      role: input.role,
      status: "budget_exhausted",
      summary:
        language === "en"
          ? `The subagent reached its ${input.maxRounds}-round safety budget. Use its evidence as partial results or delegate a narrower follow-up.`
          : `子 Agent 已达到 ${input.maxRounds} 轮安全预算。请把现有证据视为部分结果，或委派一个范围更小的后续任务。`,
      evidence: compactSubagentEvidence(evidence),
      steps: toolSteps.slice(-60),
      usage: usageTotal,
      rounds: input.maxRounds,
      instructionFiles: [...instructionContext.loadedFiles],
    };
    emit({
      type: "subagent.completed",
      agentId,
      role: input.role,
      status: result.status,
      rounds: result.rounds,
      toolSteps: toolSteps.length,
      summary: result.summary,
    });
    return result;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const result = {
      agentId,
      role: input.role,
      status: "failed",
      summary: error.message,
      evidence: compactSubagentEvidence(evidence),
      steps: toolSteps.slice(-60),
      usage: usageTotal,
    };
    emit({
      type: "subagent.failed",
      agentId,
      role: input.role,
      error: error.message,
    });
    return result;
  }
}

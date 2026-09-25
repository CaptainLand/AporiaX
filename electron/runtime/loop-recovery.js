import { compactConversationForRequest, estimateConversationTokens } from "../agent-context.js";
import { harnessFeedback } from "./task-conversation.js";
import { providerErrorCategory } from "./provider-errors.js";
import { conversationTokenMaterial } from "./multimodal-budget.js";
import { runtimeRunControl, saveRuntimeCheckpoint } from "./durable-run.js";
import { isTemporaryNetworkError } from "./run-control.js";
import { createLoopRequestIdentity, createRepairRequestIdentity, withLoopRequestIdentity, rememberCloudQuotaPause } from "./cloud-request-identity.js";

// Recover inference, never tool execution. A bounded repair must change the
// request. Do not replay an already-executed/uncertain external operation.
export async function completeLoopRequest({ conversation, contextCheckpoints, accounting,
  contextWindowTokens, getBody, complete, persist = async () => {}, onEvent = () => {},
  onFailedUsage = () => {}, shouldYield = () => false, signal, plan = null, scopeId = "main" }) {
  const control = runtimeRunControl();
  let requestIdentity = createLoopRequestIdentity(scopeId);
  let compactions = requestIdentity.identity.compactions || 0, corrections = requestIdentity.identity.repairCount || 0;
  let repairMaxTokens = requestIdentity.identity.repairMaxTokens || null;
  const requestBody = (messages) => {
    const body = getBody(messages);
    if (!repairMaxTokens) return body;
    if (body.max_completion_tokens !== undefined) return { ...body, max_completion_tokens: repairMaxTokens };
    if (body.max_output_tokens !== undefined) return { ...body, max_output_tokens: repairMaxTokens };
    return { ...body, max_tokens: repairMaxTokens };
  };
  const partialAnswers = [];
  const waitForQuota = async (quota) => {
    // Commit history and the pause intent before waiting. A process restart
    // restores the same gate; it does not silently start another paid call.
    await persist();
    await rememberCloudQuotaPause(requestIdentity, quota);
    const reason = quota.temporary ? quota.reason === "daily-budget" ? "provider-budget-wait" : "quota-wait" : quota.reason === "daily-budget" ? "daily-budget" : "quota";
    control.pause(reason);
    await control.flush();
    onEvent({ type: "response.quota.paused", reason, temporary: quota.temporary });
    const timer = quota.temporary ? setTimeout(() => control.resume(reason), 30_000) : null;
    try { await control.waitIfPaused(signal); }
    finally { if (timer) clearTimeout(timer); }
    await rememberCloudQuotaPause(requestIdentity, null);
    onEvent({ type: "response.reset", phase: "quota-resume" });
  };
  if (control && requestIdentity.identity.quotaPause) await waitForQuota(requestIdentity.identity.quotaPause);
  while (true) {
    signal?.throwIfAborted();
    await control?.waitIfPaused(signal);
    if (shouldYield()) return { interrupted: true, message: { content: "" }, usage: null, requestConversation: [...conversation] };
    const requestConversation = [...conversation];
    try {
      const result = await withLoopRequestIdentity(requestIdentity, () => control
        ? control.runRequest((requestSignal) => complete(requestBody(requestConversation), requestSignal), signal)
        : complete(requestBody(requestConversation), signal));
      control?.networkSucceeded();
      // The completed response is already durable. Pause before returning any
      // tools to execution; resuming consumes that response, never regenerates it.
      if (control && result.cloudQuota?.afterResponse && !requestIdentity.identity.quotaResponseAcknowledged)
        await waitForQuota(result.cloudQuota);
      await control?.waitIfPaused(signal);
      if (shouldYield()) return { ...result, interrupted: true, requestConversation, partialAnswers };
      return { ...result, requestConversation, partialAnswers,
        // Completed text-only continuation includes the preserved prefix. Tool
        // continuations keep normal protocol messages; they are not concatenated.
        message: partialAnswers.length && !result.interrupted && !result.message?.tool_calls?.length
          ? { ...result.message, aporiaNative: undefined, aporiaContinuation: result.message, content: [...partialAnswers, result.message?.content || ""].join("\n") }
          : result.message };
    } catch (error) {
      if (!requestIdentity.result && (error?.attemptUsage || error?.usage)) await onFailedUsage(error.attemptUsage || error.usage);
      if (signal?.aborted) throw error;
      if (control && error.cloudQuota && error.safeToRepair) {
        if (error.cloudQuota.truncated) {
          await saveRuntimeCheckpoint({ scopeId: "incomplete-response:" + scopeId, phase: "quota-limited-response", incomplete: true,
            content: error.partialMessage?.content || "", usage: error.attemptUsage || error.usage || null, toolCallsExecuted: false });
          if (!error.partialToolCalls && error.partialMessage?.content?.trim()) conversation.push({ role: "assistant", ...error.partialMessage });
          conversation.push(harnessFeedback("Cloud quota limited the previous response. No tool calls from that incomplete response were executed. After quota is restored, continue from confirmed work with complete, smaller actions. Do not replay completed tools."));
          await persist();
          // This is a confirmed settled truncation, not a transport retry. Do
          // not consume or double the ordinary output-limit repair budget.
          requestIdentity = await createRepairRequestIdentity(requestIdentity, { corrections, compactions, outputTokenLimit: repairMaxTokens });
        }
        await waitForQuota(error.cloudQuota);
        continue;
      }
      if (control && (error?.code === "TASK_SUSPENDED" || isTemporaryNetworkError(error))) {
        if (error.code !== "TASK_SUSPENDED") control.waitForNetwork();
        await saveRuntimeCheckpoint({ scopeId: "incomplete-response:" + scopeId, phase: "suspended-response",
          incomplete: true, content: error.partialMessage?.content || "", usage: error.attemptUsage || error.usage || null,
          usageIncomplete: !error.usage, toolCallsExecuted: false });
        await persist();
        onEvent({ type: "response.suspended", incomplete: true, usageIncomplete: !error.usage });
        await control.waitIfPaused(signal);
        // Resume the same logical request/key using confirmed history, never partial calls.
        onEvent({ type: "response.reset", phase: "environment-recovery" });
        continue;
      }
      if (shouldYield()) return { interrupted: true, message: { content: "" }, usage: null, requestConversation };
      const category = providerErrorCategory(error);
      if (category === "context" && compactions < 2 && error.safeToRepair !== false) {
        const before = conversationTokenMaterial(conversation);
        const inputBudgetTokens = Math.max(1, Math.floor(estimateConversationTokens(conversation, accounting) * 0.70));
        const checkpoint = compactConversationForRequest({ conversation, contextCheckpoints,
          accounting, contextWindowTokens, inputBudgetTokens, plan, onEvent });
        const after = conversationTokenMaterial(conversation);
        if (!checkpoint || after.serialized.length >= before.serialized.length ||
            estimateConversationTokens(conversation, accounting) > inputBudgetTokens) throw error;
        compactions++;
      } else if (category === "output-limit" && corrections < 1 && error.streamComplete && error.safeToRepair !== false) {
        if (!error.partialToolCalls && error.partialMessage?.content?.trim()) {
          partialAnswers.push(error.partialMessage.content);
          conversation.push({ role: "assistant", ...error.partialMessage });
          conversation.push(harnessFeedback("The previous answer reached the output limit. Continue from that partial text without repeating it. No tool call from the truncated response was executed. Do not claim an unfinished task is complete."));
        } else {
          // Never insert an incomplete tool JSON or an opaque reasoning-only
          // assistant turn. Previously confirmed tools/history remain intact.
          conversation.push(harnessFeedback("The previous model generation reached its output limit before producing a complete answer/tool call. NONE of the calls from that truncated response were executed. This is the one bounded repair. Use the confirmed history, keep reasoning concise, and produce smaller complete tool actions one at a time; do not repeat tools that already completed."));
        }
        const limit = Number(error.outputTokenLimit), maximum = Number(error.maxOutputTokens);
        if (Number.isSafeInteger(limit) && limit > 0 && Number.isSafeInteger(maximum) && maximum >= limit)
          repairMaxTokens = Math.min(maximum, limit * 2);
        corrections++;
      } else if (category === "tool-protocol" && corrections < 1 && (error.streamComplete || error.safeToRepair)) {
        conversation.push(harnessFeedback("The previous model response contained an invalid tool-call argument object or identifier. NONE of its tool calls were executed. Replan and produce complete, valid tool calls, or explain the blocker. Do not assume a side effect occurred."));
        corrections++;
      } else {
        if (category === "output-limit" && error.streamComplete && !error.partialToolCalls && error.partialMessage?.content?.trim()) {
          conversation.push({ role: "assistant", ...error.partialMessage });
          await persist(); // Even an exhausted continuation keeps its partial text.
        }
        throw error;
      }
      await persist();
      requestIdentity = await createRepairRequestIdentity(requestIdentity, { corrections, compactions, outputTokenLimit: repairMaxTokens });
      onEvent({ type: "response.recovery", category, compactions, corrections, outputTokenLimit: repairMaxTokens });
      onEvent({ type: "response.reset", phase: "bounded-recovery" });
      // Steering gets another boundary before any subsequent network call.
      if (shouldYield()) return { interrupted: true, message: { content: "" }, usage: null, requestConversation };
    }
  }
}

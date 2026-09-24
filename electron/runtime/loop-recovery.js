import { compactConversationForRequest, estimateConversationTokens } from "../agent-context.js";
import { harnessFeedback } from "./task-conversation.js";
import { providerErrorCategory } from "./provider-errors.js";
import { conversationTokenMaterial } from "./multimodal-budget.js";
import { runtimeRunControl, saveRuntimeCheckpoint } from "./durable-run.js";
import { isTemporaryNetworkError } from "./run-control.js";
import { createLoopRequestIdentity, withLoopRequestIdentity } from "./cloud-request-identity.js";

// Recover inference, never tool execution. A bounded repair must change the
// request. Do not replay an already-executed/uncertain external operation.
export async function completeLoopRequest({ conversation, contextCheckpoints, accounting,
  contextWindowTokens, getBody, complete, persist = async () => {}, onEvent = () => {},
  onFailedUsage = () => {}, shouldYield = () => false, signal, plan = null, scopeId = "main" }) {
  const control = runtimeRunControl();
  let requestIdentity = createLoopRequestIdentity(scopeId);
  let compactions = 0, corrections = 0;
  const partialAnswers = [];
  while (true) {
    signal?.throwIfAborted();
    await control?.waitIfPaused(signal);
    if (shouldYield()) return { interrupted: true, message: { content: "" }, usage: null, requestConversation: [...conversation] };
    const requestConversation = [...conversation];
    try {
      const result = await withLoopRequestIdentity(requestIdentity, () => control
        ? control.runRequest((requestSignal) => complete(getBody(requestConversation), requestSignal), signal)
        : complete(getBody(requestConversation), signal));
      control?.networkSucceeded();
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
      if (category === "context" && compactions < 2) {
        const before = conversationTokenMaterial(conversation);
        const inputBudgetTokens = Math.max(1, Math.floor(estimateConversationTokens(conversation, accounting) * 0.70));
        const checkpoint = compactConversationForRequest({ conversation, contextCheckpoints,
          accounting, contextWindowTokens, inputBudgetTokens, plan, onEvent });
        const after = conversationTokenMaterial(conversation);
        if (!checkpoint || after.serialized.length >= before.serialized.length ||
            estimateConversationTokens(conversation, accounting) > inputBudgetTokens) throw error;
        compactions++;
      } else if (category === "output-limit" && corrections < 1 && error.streamComplete &&
                 !error.partialToolCalls && error.partialMessage?.content?.trim()) {
        partialAnswers.push(error.partialMessage.content);
        conversation.push({ role: "assistant", ...error.partialMessage });
        conversation.push(harnessFeedback("The previous answer reached the output limit. Continue from that partial text without repeating it. No tool call from the truncated response was executed. Do not claim an unfinished task is complete."));
        corrections++;
      } else if (category === "tool-protocol" && corrections < 1 && error.streamComplete) {
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
      requestIdentity = createLoopRequestIdentity(scopeId); // Explicit bounded repair changes the request.
      onEvent({ type: "response.recovery", category, compactions, corrections });
      onEvent({ type: "response.reset", phase: "bounded-recovery" });
      // Steering gets another boundary before any subsequent network call.
      if (shouldYield()) return { interrupted: true, message: { content: "" }, usage: null, requestConversation };
    }
  }
}

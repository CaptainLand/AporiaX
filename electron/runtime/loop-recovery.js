import { compactConversationForRequest, estimateConversationTokens } from "../agent-context.js";
import { harnessFeedback } from "./task-conversation.js";
import { providerErrorCategory } from "./provider-errors.js";
import { conversationTokenMaterial } from "./multimodal-budget.js";

// Recover inference, never tool execution. A bounded repair must change the
// request. Do not replay an already-executed/uncertain external operation.
export async function completeLoopRequest({ conversation, contextCheckpoints, accounting,
  contextWindowTokens, getBody, complete, persist = async () => {}, onEvent = () => {},
  onFailedUsage = () => {}, shouldYield = () => false, signal, plan = null }) {
  let compactions = 0, corrections = 0;
  const partialAnswers = [];
  while (true) {
    signal?.throwIfAborted();
    const requestConversation = [...conversation];
    try {
      const result = await complete(getBody(requestConversation));
      return { ...result, requestConversation, partialAnswers,
        // Completed text-only continuation includes the preserved prefix. Tool
        // continuations keep normal protocol messages; they are not concatenated.
        message: partialAnswers.length && !result.interrupted && !result.message?.tool_calls?.length
          ? { ...result.message, aporiaNative: undefined, aporiaContinuation: result.message, content: [...partialAnswers, result.message?.content || ""].join("\n") }
          : result.message };
    } catch (error) {
      if (error?.attemptUsage || error?.usage) await onFailedUsage(error.attemptUsage || error.usage);
      if (signal?.aborted) throw error;
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
      onEvent({ type: "response.recovery", category, compactions, corrections });
      onEvent({ type: "response.reset", phase: "bounded-recovery" });
      // Steering gets another boundary before any subsequent network call.
      if (shouldYield()) return { interrupted: true, message: { content: "" }, usage: null, requestConversation };
    }
  }
}

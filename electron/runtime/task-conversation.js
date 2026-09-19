// Local provenance is intentionally removed before messages cross a provider API.
// A tool/reviewer cannot acquire user authority by using the API's user role.
export function taskRequest(message) {
  return isHumanMessage(message)
    ? { ...message, aporiaSource: "human", aporiaPinned: !message.aporiaSupersededBy }
    : message;
}

export function harnessFeedback(content) {
  return { role: "user", content, aporiaSource: "harness" };
}

export function isHumanMessage(message) {
  return message?.role === "user" && !["harness", "retrieval"].includes(message.aporiaSource);
}

export function providerMessages(messages) {
  return (messages || []).map((message, index) => {
    if (!message || typeof message !== "object") throw invalidMessage(index, "missing message");
    const { aporiaSource, aporiaPinned, aporiaSupersededBy, aporiaTaskBrief, aporiaContinuation, ...wire } = message;
    // Tool-only assistant messages may omit text. Tool receipts may not: an
    // undefined property disappears entirely when the request is serialized.
    if (wire.role === "assistant" && wire.content === undefined && wire.tool_calls?.length) wire.content = null;
    const textOrParts = typeof wire.content === "string" || Array.isArray(wire.content);
    if (wire.role === "tool" ? typeof wire.content !== "string"
      : !textOrParts && !(wire.role === "assistant" && wire.content === null && wire.tool_calls?.length)) {
      throw invalidMessage(index, `invalid or missing content for ${wire.role || "unknown role"}`);
    }
    if (aporiaSupersededBy && typeof wire.content === "string") wire.content =
      `[Historical user requirements superseded by a later explicit user reset; retained for reference, not active instructions.]\n${wire.content}`;
    return wire;
  });
}

function invalidMessage(index, reason) {
  const error = new Error(`MODEL_MESSAGE_INVALID: messages[${index}]: ${reason}. Request stopped locally before contacting the model.`);
  error.code = "MODEL_MESSAGE_INVALID";
  error.retryable = false;
  return error;
}

export function requireToolResult(result, toolName) {
  if (!result || result.modelResult === undefined) {
    const error = new Error(`TOOL_RESULT_INVALID: ${toolName} returned no modelResult. Execution outcome is unknown; inspect actual effects before retrying, do not blindly replay the operation.`);
    error.code = "TOOL_RESULT_INVALID";
    throw error;
  }
  return result;
}

function recoveredReceipt(message) {
  if (message?.role !== "tool" || typeof message.content === "string") return message;
  // Old checkpoints can contain a receipt whose result was never saved. Do
  // not fabricate success or rerun the saved operation to obtain its result.
  return { ...message, content: JSON.stringify(message.content ?? {
    recovered: true, outcome: "unknown", error: "RECOVERED_TOOL_RESULT_MISSING",
    note: "The saved tool receipt has no result. Inspect current state; do not blindly replay this operation or assume it succeeded.",
  }) };
}

export function recoverConversation(messages) {
  // Do not execute a saved tool request. Complete its protocol pair with an
  // explicit unknown-outcome receipt and let the model inspect actual effects.
  const result = [];
  for (let index = 0; index < (messages || []).length; index++) {
    const message = recoveredReceipt(messages[index]);
    result.push(message);
    if (!message.tool_calls?.length) continue;
    const received = new Set();
    while (messages[index + 1]?.role === "tool") {
      const receipt = recoveredReceipt(messages[++index]); result.push(receipt); received.add(receipt.tool_call_id);
    }
    for (const call of message.tool_calls) {
      if (!received.has(call.id)) result.push({ role: "tool", tool_call_id: call.id,
        content: JSON.stringify({ recovered: true, outcome: "unknown", note: "Execution may have happened before interruption. Inspect current state and operation receipts; do not blindly replay this tool." }) });
    }
  }
  return result;
}

// Keep provider-bound continuation internally even when public delivery combines
// text chunks. Only public text is returned to the conversation UI.
export function assistantHistoryMessage(message) {
  const source = message.aporiaContinuation || message;
  return { role: "assistant", content: source.content ?? "",
    ...(source.tool_calls?.length ? { tool_calls: source.tool_calls } : {}),
    ...(source.reasoning_content ? { reasoning_content: source.reasoning_content } : {}),
    ...(source.aporiaNative ? { aporiaNative: source.aporiaNative } : {}) };
}

// Local provenance is intentionally removed before messages cross a provider API.
// A tool/reviewer cannot acquire user authority by using the API's user role.
export function taskRequest(message) {
  return message?.role === "user"
    ? { ...message, aporiaSource: "human", aporiaPinned: true }
    : message;
}

export function harnessFeedback(content) {
  return { role: "user", content, aporiaSource: "harness" };
}

export function isHumanMessage(message) {
  return message?.role === "user" && !["harness", "retrieval"].includes(message.aporiaSource);
}

export function providerMessages(messages) {
  return (messages || []).map((message) => {
    const { aporiaSource, aporiaPinned, ...wire } = message;
    return wire;
  });
}

export function recoverConversation(messages) {
  // Do not execute a saved tool request. Complete its protocol pair with an
  // explicit unknown-outcome receipt and let the model inspect actual effects.
  const result = [];
  for (let index = 0; index < (messages || []).length; index++) {
    const message = messages[index];
    result.push(message);
    if (!message.tool_calls?.length) continue;
    const received = new Set();
    while (messages[index + 1]?.role === "tool") {
      const receipt = messages[++index]; result.push(receipt); received.add(receipt.tool_call_id);
    }
    for (const call of message.tool_calls) {
      if (!received.has(call.id)) result.push({ role: "tool", tool_call_id: call.id,
        content: JSON.stringify({ recovered: true, outcome: "unknown", note: "Execution may have happened before interruption. Inspect current state and operation receipts; do not blindly replay this tool." }) });
    }
  }
  return result;
}

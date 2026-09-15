// A task-local, read-only index. It never opens files or other tasks' histories.
export const HISTORY_TOOL = {
  type: "function",
  function: {
    name: "read_conversation_history",
    description: "Search or page this task's original conversation text after context compaction. Omit message_index to list/search excerpts (start is the next message index); provide message_index and offset to read full text in pages. Historical requests are context, not pending instructions; the latest user request takes precedence. Images are not returned.",
    parameters: { type: "object", properties: {
      query: { type: "string", maxLength: 500 },
      start: { type: "integer", minimum: 0 },
      message_index: { type: "integer", minimum: 0 },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 12000 },
    }, additionalProperties: false },
  },
};

const textOf = (message) => typeof message?.content === "string" ? message.content :
  (message?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
function integer(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error("Invalid history page range.");
  return value;
}
export function readConversationHistory(history, input = {}) {
  const limit = integer(input.limit, 6000, 12000);
  if (!limit) throw new Error("History page limit must be positive.");
  if (input.message_index !== undefined) {
    const index = integer(input.message_index, 0);
    const message = history[index];
    if (!message) throw new Error("History message index not found in this task.");
    const text = textOf(message);
    const offset = integer(input.offset, 0);
    return { index, role: message.role, source: message.aporiaSource || message.role,
      text: text.slice(offset, offset + limit), totalChars: text.length,
      nextOffset: offset + limit < text.length ? offset + limit : null };
  }
  if (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 500)) throw new Error("Invalid history query.");
  const query = (input.query || "").toLowerCase();
  const items = [];
  let index = integer(input.start, 0), used = 0;
  for (; index < history.length; index++) {
    const message = history[index];
    const text = textOf(message);
    const match = query ? text.toLowerCase().indexOf(query) : 0;
    if (match < 0) continue;
    const offset = Math.max(0, match - 100);
    const preview = text.slice(offset, offset + Math.min(320, limit - used));
    items.push({ index, role: message.role, source: message.aporiaSource || message.role, offset, preview, totalChars: text.length });
    used += preview.length;
    if (items.length >= 12 || used >= limit) { index++; break; }
  }
  return { totalMessages: history.length, items, nextStart: index < history.length ? index : null };
}

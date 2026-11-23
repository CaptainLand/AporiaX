export function captureThreadPosition(body, withTurn = false) {
  if (!body) return { top: 0, stickToBottom: true, anchor: null };
  const top = body.scrollTop;
  const stickToBottom = body.scrollHeight - body.clientHeight - top < 72;
  let anchor = null;
  if (withTurn && !stickToBottom) {
    const bounds = body.getBoundingClientRect();
    const x = bounds.left + body.clientWidth / 2;
    // Probe a few points near the top, not every message in the transcript.
    for (const inset of [4, 20, 48, 96, 160, 240]) {
      if (inset >= body.clientHeight) break;
      const element = body.ownerDocument.elementFromPoint(x, bounds.top + body.clientTop + inset);
      const turn = element?.closest("[data-thread-history-turn]") || element?.closest("[data-thread-turn]");
      if (turn && body.contains(turn)) {
        anchor = { id: turn.dataset.threadTurn, offset: turn.getBoundingClientRect().top - bounds.top };
        break;
      }
    }
  }
  return { top, stickToBottom, anchor };
}

export function restoreThreadPosition(body, memory, dialogue) {
  if (!body) return 0;
  if (!memory) { body.scrollTop = dialogue ? body.scrollHeight : 0; return 0; }
  if (memory.stickToBottom) { body.scrollTop = body.scrollHeight; return 0; }
  const turn = dialogue && memory.anchor?.id
    ? body.querySelector(`[data-thread-turn="${CSS.escape(memory.anchor.id)}"]`) : null;
  const from = body.scrollTop;
  const target = turn
    ? from + turn.getBoundingClientRect().top - body.getBoundingClientRect().top - memory.anchor.offset
    : memory.top;
  body.scrollTop = target;
  return Math.abs(body.scrollTop - from);
}

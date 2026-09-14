export const COLLAPSED_DROP_EDGE = 240;

export function isCollapsedDropEdge(event, root, edge = COLLAPSED_DROP_EDGE) {
  if (!root || !Number.isFinite(event?.clientX)) return false;
  const rect = typeof root.getBoundingClientRect === "function"
    ? root.getBoundingClientRect()
    : root;
  const width = Number(rect?.width);
  const right = Number(rect?.right);
  if (!Number.isFinite(width) || !Number.isFinite(right)) return false;
  const zone = Math.min(edge, Math.max(96, width * 0.3));
  return event.clientX >= right - zone;
}

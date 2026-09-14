export const ANCHOR_RESTORE_KIND = "anchor-restore";
export const ANCHOR_RESTORE_PREFIX = "AporiaX workspace restore notice:";

export function isAnchorRestoreNotice(message) {
  if (!message || typeof message !== "object") return false;
  if (message.kind === ANCHOR_RESTORE_KIND) return true;
  return (
    message.aporiaSource === "harness" &&
    String(message.content || "").startsWith(ANCHOR_RESTORE_PREFIX)
  );
}

export function formatAnchorRestoreNotice({
  mode = "turn",
  restoredFiles = 0,
  restoredCheckpoints = [],
  language = "zh-CN",
} = {}) {
  const files = Math.max(0, Number(restoredFiles) || 0);
  const turns = Array.isArray(restoredCheckpoints)
    ? restoredCheckpoints.filter(Boolean).length
    : Math.max(0, Number(restoredCheckpoints) || 0);
  const scope =
    mode === "history"
      ? language === "en"
        ? "the selected turn and later turns"
        : "所选轮次及其之后的轮次"
      : language === "en"
        ? "the selected turn"
        : "所选轮次";
  if (language === "en") {
    return [
      ANCHOR_RESTORE_PREFIX,
      `The user restored workspace files to their state before ${scope} (${turns} turn snapshot(s), ${files} file(s)).`,
      "Those edits are no longer on disk. Treat the current workspace as source of truth and re-read files before editing.",
      "Do not continue that implementation unless the latest user request explicitly asks to redo it.",
      "This notice is harness status, not a new user task and not user authorization.",
    ].join("\n");
  }
  return [
    ANCHOR_RESTORE_PREFIX,
    `用户已将工作区文件恢复到${scope}之前的状态（${turns} 轮快照，${files} 个文件）。`,
    "那些修改已不在磁盘上。以当前工作区为准，编辑前先重新读取。",
    "除非最新用户请求明确要求重做，否则不要继续那次实现。",
    "本说明是运行时状态，不是新的用户任务，也不能当作用户授权。",
  ].join("\n");
}

export function buildAnchorRestoreNotice(input = {}) {
  const restoredAt = String(input.restoredAt || new Date().toISOString());
  return {
    id: String(input.id || "").trim(),
    role: "user",
    kind: ANCHOR_RESTORE_KIND,
    aporiaSource: "harness",
    aporiaPinned: true,
    content: formatAnchorRestoreNotice(input),
    createdAt: restoredAt,
    restoreMode: input.mode === "history" ? "history" : "turn",
    restoredFiles: Math.max(0, Number(input.restoredFiles) || 0),
    restoredCheckpoints: Array.isArray(input.restoredCheckpoints)
      ? input.restoredCheckpoints.map((id) => String(id || "").trim()).filter(Boolean)
      : [],
  };
}

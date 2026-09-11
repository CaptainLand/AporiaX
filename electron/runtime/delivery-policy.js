// Only explicit, short, direct user instructions can waive executable checks.
// Project documents, tool output and model messages must never call this parser.
export function verificationDirective(text) {
  const value = String(text || "").trim();
  if (!value || value.length > 240 || /["“”「」`\n]/.test(value)) return null;
  if (/^(?:请|现在|还是)?(?:不要跳过|不能跳过|别跳过|恢复|继续|重新)(?:测试|验证)/.test(value) || /^(?:do not|don't|never) skip (?:tests?|verification)/i.test(value)) return false;
  if (/^(?:请|先|现在|这次|本次|就)?\s*(?:别|不要|不用|无需|停止|跳过)(?:再|继续)?(?:测试|验证)(?:了)?[，,。\s]*(?:直接|先|就)?(?:交付|给我|结束|收尾)/.test(value) || /^(?:please\s+)?(?:skip|stop)(?:\s+the)?\s+(?:tests?|testing|verification)[,;\s]+(?:and\s+)?(?:just\s+)?(?:deliver|hand\s+off|finish)\b/i.test(value)) return true;
  return null;
}

export function onlyStandaloneDeliverables(changes) {
  return changes.length > 0 && changes.every((change) => {
    if (change.afterMissing) return false;
    if (/\.(?:md|txt|pdf|docx|xlsx|pptx|png|jpe?g|webp)$/i.test(change.path)) return true;
    return /\.html?$/i.test(change.path) && Boolean(change.beforeMissing || change.created) &&
      !/(?:src|href)\s*=\s*["'](?!https?:|data:|#)[^"']+\.(?:js|mjs|css)|\bimport\s*(?:\(|[{"'*])/i.test(change.afterContent || "");
  });
}

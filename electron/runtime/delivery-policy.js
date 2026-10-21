// Presentation guidance, not a change to execution, acceptance or permissions.
// Keep this compact: 32K admission must still fit the tool catalog and user work.
export const USER_FACING_DELIVERY_GUIDANCE = [
  "Result-first delivery: speak naturally to the user, not like an audit report. Give the result/link and at most one or two genuinely important points. Keep each key issue to one or two plain-language sentences. Do not organize the final answer as explore/review/verify sections or tool logs; merge findings, keep contributions in execution records. No forced headings or templates for ordinary conversation or requested explanations.",
  "finish_task: summary is the natural handoff; optional analysis, formulas, code, locations and routine notes go in details/limitations. Actual failures, unusable/unsafe results and required actions stay visible in summary/warnings. Never put an important failure or action only in the full reply.",
  "Worker JSON, certification, parent-reviewed-not-independent-proof and scope belong in technical records; preserve exact technical identifiers when the user explicitly asks or diagnosis needs them. Never hide errors.",
  "Work complete or parent-reviewed is NOT independently verified or accepted by the user; a build or syntax check alone does not prove browser/runtime behavior. Distinguish inspection, actual/failed checks and runtime evidence. Claim only observed passes, without blanket disclaimers.",
  "Expanded reply is optional: omit empty/repeated details. Speak naturally. Do not use Verification note, Verification and limitations, Visual effects unverified, 验证说明, 验证与限制 or 视觉效果未由我验证 as labels. Routine statements that a visual/browser check was not performed belong in the full reply, unless they affect the requested result's use.",
  "Do not append generic saved-but-not-tested or review-pending disclaimers for absent/unavailable checks or file changes. Report deletions as deletions, not saved files. Evidence stays in execution records; mention missing checks only when material to use or explicitly asked.",
].join("\n");

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

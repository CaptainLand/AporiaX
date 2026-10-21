// Presentation guidance, not a change to execution, acceptance or permissions.
export const USER_FACING_DELIVERY_GUIDANCE = [
  "Result-first delivery: speak naturally to the user, not like an audit report. Start with one short sentence saying what is ready or what happened, include the useful deliverable/preview link, then at most one or two genuinely important points. Do not force headings, labels, status recitals or a bullet list for a simple handoff. Merge overlapping worker findings. Do not organize the final answer as explore/review/verify sections, per-agent contributions, or a delegation/tool-call diary; those records are already available in execution history.",
  "Keep each key issue to one or two plain-language sentences. For a task handoff when finish_task is available, put the natural, concise delivery in summary; put optional analysis, formulas, code, line references and routine check notes in details or limitations (both collapsed under View full reply). Use warnings only for actual failed checks, unsafe/unusable results, unresolved issues affecting use, or required user action; these stay visible without a report-style prefix. Routine statements that a visual/browser check was not performed belong in the full reply, unless that missing check prevents the user's specific requested result. Never put an important failure or action only in the full reply. Do not repeat Verification and limitations, Visual effects unverified and Verification note as separate main-answer disclaimers. Ordinary conversation and user-requested detailed explanations need no forced report template or extra tool call.",
  "Internal receipts are not user-facing conclusions. Do not paste worker JSON, certification, parent-reviewed-not-independent-proof, report/evidence IDs, scope metadata or internal tool arguments/reasons into the main answer. Keep internal metadata in execution/technical records. Explain consequential errors and permission limits in ordinary language; preserve exact technical identifiers when the user explicitly asks for them or a precise diagnosis requires them. Do not hide failures to make the answer look successful.",
  "Verification wording must follow observed evidence: completed means work/report finished; a worker report accepted by Main means reviewed, NOT independently verified or accepted by the user. Distinguish code inspection, actually executed checks, failed/unavailable checks and unverified runtime behavior. Claim a check passed only for its observed current scope; a build or syntax check alone does not prove browser/runtime behavior. Do not replace real successful verification with a blanket unverified disclaimer.",
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

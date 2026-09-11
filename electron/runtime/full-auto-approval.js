import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const DELETION = /\b(?:rm|rmdir|rd|del|erase|remove-item|delete|unlink|rmtree|rimraf|remove_file|delete_file|delete_directory)\b/i;
const COMPOSITION = /[;&|><`\r\n$*?]|%[^%]+%/;

// Best-effort protection, NOT isolation: opaque scripts/MCP can have indirect
// effects that cannot be classified from their command name or arguments.
export async function fullAutoRequiresConfirmation(details, workspaceRoot) {
  if (details?.kind === "recovery-reconciliation") return "异常恢复可能重复执行副作用，必须重新核对。";
  const tool = String(details?.toolName || details?.tool || "");
  if (["read_file", "read_external_file", "list_directory", "search_text"].includes(tool)) return "";
  const command = String(details?.command || "");
  if (!DELETION.test([tool, command, JSON.stringify(details?.input || {})].join(" "))) return "";
  const match = command.match(/^\s*(?:rm|rmdir|rd|del|erase|Remove-Item)\s+(.+)$/i);
  if (!match || COMPOSITION.test(match[1]) || !workspaceRoot) return "删除操作的目标范围不明确，需要确认。";
  const tokens = match[1].match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const targets = [];
  for (const token of tokens) {
    if (/^(?:--|-[rRfFiIvV]+|-(?:LiteralPath|Path|Recurse|Force|Confirm)|\/[sSqQfF])$/.test(token)) continue;
    if (/^-/.test(token)) return "删除参数无法可靠识别，需要确认。";
    targets.push(token.replace(/^(['"])(.*)\1$/, "$2"));
  }
  if (!targets.length) return "删除操作没有明确目标，需要确认。";
  try {
    const root = await realpath(workspaceRoot);
    const cwd = await realpath(resolve(root, details.cwd || "."));
    for (const target of targets) {
      const physical = await realpath(resolve(cwd, target));
      const rel = relative(root, physical);
      if (!rel || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel)) return "删除目标在工作区外或指向工作区根目录，需要确认。";
    }
    return "";
  } catch { return "无法确认删除目标的真实路径，需要确认。"; }
}

export function createFullAutoApproval({ approvalMode, workspaceRoot, requestApproval, emit = () => {} }) {
  if (approvalMode !== "full-auto") return requestApproval;
  return async (details = {}) => {
    const reason = await fullAutoRequiresConfirmation(details, workspaceRoot);
    if (reason) return requestApproval({ ...details, reason: details.kind === "recovery-reconciliation" ? details.reason || reason : reason });
    emit({ type: "approval.automatic", tool: details.toolName || details.tool || details.kind, mode: "full-auto" });
    return { approved: true, automatic: true, scope: "task" };
  };
}

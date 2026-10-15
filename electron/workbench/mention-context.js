import { resolve } from "node:path";

// Explicit, bounded snapshots only: never navigate, execute, upload or mutate.
export async function readMentionContext(context, token, { resources, git }) {
  if (token?.kind === "git") {
    if (!["changes", "staged", "status"].includes(token.value)) throw new Error("Unsupported Git reference.");
    const status = await git.request({ workspacePath: context.workspacePath, operation: "status" });
    if (token.value === "status" || !status.repository || status.readOnly) return status;
    const files = status.files.filter(file => token.value !== "staged" || file.staged);
    const diffs = []; let chars = 0;
    for (const file of files.slice(0, 20)) {
      if (file.untracked) { diffs.push({ path: file.path, note: "Untracked content omitted; explicitly mention this file to include it." }); continue; }
      for (const staged of token.value === "staged" ? [true] : [true, false]) {
        if (staged ? !file.staged : !file.unstaged) continue;
        const diff = await git.request({ workspacePath: context.workspacePath, operation: "diff", path: file.path, staged });
        const text = String(diff.text || "").slice(0, Math.max(0, 20000 - chars));
        chars += text.length; diffs.push({ path: file.path, staged, text, truncated: diff.truncated || text.length < String(diff.text || "").length });
        if (chars >= 20000) break;
      }
      if (chars >= 20000) break;
    }
    return { source: "explicit-git-mention", branch: status.branch, totalFiles: status.totalFiles, diffs, truncated: status.truncated || files.length > 20 || chars >= 20000 };
  }
  const resource = resources.get(token?.value);
  if (!resource || resource.taskId !== context.taskId || resolve(resource.workspacePath || ".") !== resolve(context.workspacePath || ".")) throw new Error("Reference does not belong to this task.");
  if (token.kind === "browser" && resource.kind === "browser") return resource.mentionSnapshot();
  if (token.kind === "terminal" && resource.kind === "terminal") return { title: resource.title, status: resource.status, output: resource.output.slice(-20000), truncated: resource.offset > 0 || resource.output.length > 20000 };
  if (token.kind === "terminal" && resource.kind === "process") return resource.manager.read({ processId: resource.id, maxChars: 20000 });
  throw new Error("Unsupported task reference.");
}

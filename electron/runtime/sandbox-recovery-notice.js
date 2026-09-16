import { pathToFileURL } from "node:url";

export function appendSandboxRecoveryNotice(content, recoveries = [], language = "zh-CN") {
  if (!recoveries.length) return content;
  const english = language === "en";
  const links = [...new Map(recoveries.filter((item) => item?.directory).map((item) => [item.directory, item])).values()]
    .slice(-4).map((item, index) => `- [${english ? "Recovery folder" : "查看保留产物"} ${index + 1}](${pathToFileURL(item.directory).href})`);
  return links.length ? `${content}\n\n${english ? "Sandbox output was retained separately; it may not have been applied to the original workspace. Inspect recovery.json, workspace and before before restoring. More snapshots: Task settings → Sandbox recovery folders." : "沙箱产物已单独保留，不代表已写回原工作区。请查看 recovery.json、workspace（产物）和 before（原件）后再恢复；其他记录在任务设置 → 沙箱恢复目录。"}\n\n${links.join("\n")}` : content;
}

import { BrowserWindow, clipboard, dialog, Menu, shell } from "electron";
import { copyFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";
import { classifyLink } from "./link-target.js";

const DOCUMENT_EXTENSIONS = new Set([".txt", ".md", ".json", ".css", ".java", ".c", ".cpp", ".rs", ".go", ".log", ".csv", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf", ".docx", ".xlsx", ".pptx", ".mp3", ".mp4"]);

export async function handleDesktopLink(event, request = {}) {
  const window = BrowserWindow.fromWebContents(event.sender);
  const english = request.language === "en";
  const tr = (zh, en) => english ? en : zh;
  const link = classifyLink(request.href);
  if (!link || link.kind === "anchor") throw new Error(tr("不支持的链接", "Unsupported link"));
  let target = null;
  let directory = false;
  if (link.kind === "file") {
    if (!isAbsolute(link.target) && !isAbsolute(String(request.workspacePath || ""))) throw new Error(tr("相对路径缺少工作区", "A workspace is required for relative paths"));
    // Reject Windows device paths, ADS and network shares (including encoded forms).
    if (/[<>|?*]/.test(link.target) || /:/.test(link.target.replace(/^[a-z]:/i, ""))) throw new Error(tr("无效文件路径", "Invalid file path"));
    target = await realpath(resolve(request.workspacePath || ".", link.target));
    if (/^[\\/]{2}/.test(target)) throw new Error(tr("暂不支持网络共享路径", "Network shares are not supported"));
    const info = await stat(target);
    directory = info.isDirectory();
    if (!directory && !info.isFile()) throw new Error(tr("不是普通文件", "Not a regular file"));
  }
  const execute = async (action) => {
    if (action === "copy") { clipboard.writeText(target || link.href); return; }
    if (action === "copy-name") { clipboard.writeText(basename(target)); return; }
    if (action === "reveal") { shell.showItemInFolder(target); return; }
    if (action === "save") {
      const chosen = await dialog.showSaveDialog(window, { defaultPath: basename(target), title: tr("另存为", "Save as") });
      if (chosen.canceled || !chosen.filePath) return;
      if (resolve(chosen.filePath).toLowerCase() === target.toLowerCase()) throw new Error(tr("目标不能是原文件", "Destination must differ from the original"));
      let existing = null;
      try { existing = await realpath(chosen.filePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (existing && existing.toLowerCase() === target.toLowerCase()) throw new Error(tr("目标指向原文件", "Destination points to the original file"));
      // Existing destinations are confirmed by the native save dialog.
      await copyFile(target, chosen.filePath);
      return;
    }
    if (action === "open-with") {
      const chosen = await dialog.showOpenDialog(window, { title: tr("选择应用或 IDE 的可执行程序", "Choose an application or IDE executable"), properties: ["openFile"], filters: [{ name: "Application", extensions: ["exe"] }] });
      if (chosen.canceled || !chosen.filePaths[0]) return;
      const executable = chosen.filePaths[0];
      const isCode = /^(code|cursor|windsurf)\.exe$/i.test(basename(executable));
      const args = isCode && link.line && !directory ? ["--goto", target + ":" + link.line] : [target];
      await new Promise((accept, reject) => {
        const child = spawn(executable, args, { shell: false, detached: true, stdio: "ignore" });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); accept(); });
      });
      return;
    }
    if (action !== "open") throw new Error("Unsupported action");
    if (link.kind === "web") { await shell.openExternal(link.href); return; }
    if (!directory && !DOCUMENT_EXTENSIONS.has(extname(target).toLowerCase())) {
      const result = await dialog.showMessageBox(window, { type: "warning", title: tr("确认打开文件", "Confirm opening file"), message: tr("此文件可能运行程序或脚本。仅在信任来源时打开。", "This file may execute a program or script. Open only if trusted."), detail: target, buttons: [tr("取消", "Cancel"), tr("打开", "Open")], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return;
    }
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  };
  if (request.action !== "menu") { await execute("open"); return { ok: true }; }
  // The renderer cannot invoke save/spawn directly: those choices require a native menu click.
  return new Promise((resolveMenu) => {
    let actionPromise = null;
    const item = (label, action) => ({ label, click: () => { actionPromise = execute(action).then(() => ({ ok: true }), (error) => ({ ok: false, error: error.message })); } });
    const entries = [item(tr("打开", "Open"), "open")];
    if (target) {
      if (!directory) entries.push(item(tr("另存为…", "Save as…"), "save"));
      entries.push(item(tr("在文件夹中显示", "Show in folder"), "reveal"), item(tr("在其他应用 / IDE 中打开…", "Open in another app / IDE…"), "open-with"), { type: "separator" }, item(tr("复制路径", "Copy path"), "copy"), item(tr("复制文件名", "Copy name"), "copy-name"));
    } else entries.push(item(tr("复制链接", "Copy link"), "copy"));
    Menu.buildFromTemplate(entries).popup({ window, callback: () => setImmediate(async () => resolveMenu(actionPromise ? await actionPromise : { ok: true, canceled: true })) });
  });
}

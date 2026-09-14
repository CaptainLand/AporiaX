import { app, dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { WorkbenchBrowserSession } from "./browser-session.js";
import { installWorkbenchProvider } from "./runtime-provider.js";
import { createPersistentProcessManager } from "../runtime/process-runtime.js";
import { createHostFallbackEnvironment } from "../sandbox-runtime.js";
import { getVerifiedWorkspaceRoot } from "../runtime/workspace-runtime.js";
import { readWorkbenchFile, searchWorkbenchFiles } from "./files.js";
import { acceptLayoutGeneration } from "./layout-token.js";

const require = createRequire(import.meta.url);
export function createWorkbenchService({ getWindow, confirmExternalRead = async (path) => {
  const result = await dialog.showMessageBox(getWindow(), {
    type: "question", title: "只读预览工作区外文件", message: "允许侧栏读取此文件一次？",
    detail: path + "\n\n仅用于本次预览，不允许修改，也不会授权整个目录。",
    buttons: ["取消", "允许只读预览"], defaultId: 0, cancelId: 0,
  });
  return result.response === 1;
} }) {
  const resources = new Map();
  let visibleId = null;
  let hideEpoch = 0;
  let acceptedGeneration = 0;
  const publish = (state) => {
    const window = getWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("workbench:event", state);
  };
  const scope = (r, input) => {
    if (!r) return null;
    if (r.taskId !== input.taskId || resolve(r.workspacePath || ".") !== resolve(input.workspacePath || ".")) return null;
    return r;
  };
  const reserve = (kind) => {
    // Closed resources are safe to forget; living resources must be explicitly stopped.
    for (const [id, r] of resources) if (r.closed || r.status === "exited") resources.delete(id);
    if ([...resources.values()].filter((r) => r.kind === kind || (kind === "browser" && r.view)).length >= 12) throw new Error("运行资源已达上限，请先关闭不再使用的会话。");
  };
  function browser(context, owner = "user") {
    reserve("browser");
    const r = new WorkbenchBrowserSession({ ...context, owner, publish });
    getWindow()?.contentView.addChildView(r.view);
    r.view.setVisible(false);
    resources.set(r.id, r); r.changed(); return r;
  }
  function state(r) { return r.state ? r.state() : { id: r.id, taskId: r.taskId, workspacePath: r.workspacePath, kind: r.kind,
    title: r.title, status: r.status, owner: r.owner, cwd: r.cwd, exitCode: r.exitCode, keepAlive: Boolean(r.keepAlive), present: Boolean(r.present) }; }
  function hideView(r) {
    if (!r?.view || r.closed) return;
    try { r.wc?.setAudioMuted?.(true); } catch { /* ignore */ }
    try { r.view.setVisible(false); } catch { /* Native view may already be gone. */ }
    try { getWindow()?.contentView.removeChildView(r.view); } catch { /* already detached */ }
  }
  function attachView(r, bounds) {
    const win = getWindow();
    if (!win || !r?.view || r.closed) return false;
    hideView(r);
    try {
      win.contentView.addChildView(r.view);
      r.view.setBounds(bounds);
      return true;
    } catch {
      return false;
    }
  }
  function revealView(r, bounds) {
    if (!r?.view || r.closed) return false;
    try {
      r.view.setBounds(bounds);
      r.view.setVisible(true);
      // Windows often skips compositing a WebContentsView that was attached
      // hidden at 1×1 and then shown at the same bounds. Nudge once.
      const nudged = {
        ...bounds,
        width: Math.max(1, bounds.width + (bounds.width > 1 ? -1 : 1)),
      };
      r.view.setBounds(nudged);
      r.view.setBounds(bounds);
      try { r.wc.setAudioMuted(false); } catch { /* ignore */ }
      return true;
    } catch {
      return false;
    }
  }
  function hide(generation) {
    const incoming = Number(generation);
    if (Number.isFinite(incoming)) {
      const token = acceptLayoutGeneration(incoming, acceptedGeneration);
      if (!token.apply) return false;
      acceptedGeneration = token.accepted;
    }
    hideEpoch += 1;
    const r = resources.get(visibleId);
    visibleId = null;
    hideView(r);
    return true;
  }
  async function terminal(context) {
    reserve("terminal");
    const cwd = await getVerifiedWorkspaceRoot(context.workspacePath);
    const pty = require("node-pty");
    const shell = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : process.env.SHELL || "/bin/sh";
    const child = pty.spawn(shell, process.platform === "win32" ? ["-NoLogo"] : [], {
      name: "xterm-256color", cols: 100, rows: 28, cwd,
      // Bundled ConPTY closes the session without the legacy console-list helper race.
      ...(process.platform === "win32" ? { useConptyDll: true } : {}),
      env: createHostFallbackEnvironment(process.env, "workbench-terminal"),
    });
    let closePromise;
    let exited;
    const exitPromise = new Promise((done) => { exited = done; });
    const r = { ...context, id: `terminal_${randomUUID()}`, kind: "terminal", title: "交互终端", status: "running",
      owner: "user", cwd, output: "", offset: 0, child, exitCode: null,
      close: () => {
        if (r.status === "exited") return Promise.resolve();
        if (closePromise) return closePromise;
        closePromise = (async () => {
          child.kill();
          let timer;
          try {
            await Promise.race([exitPromise, new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("终端关闭超时，请重试。")), 7000);
            })]);
          } finally { clearTimeout(timer); }
        })().catch((error) => { closePromise = null; throw error; });
        return closePromise;
      } };
    resources.set(r.id, r);
    child.onData((data) => {
      r.output += data;
      if (r.output.length > 400000) { const removed = r.output.length - 400000; r.offset += removed; r.output = r.output.slice(removed); }
      // Output is pulled using cursors, never repeated in saved conversation events.
    });
    child.onExit(({ exitCode }) => { r.status = "exited"; r.exitCode = exitCode; exited(); publish(state(r)); });
    publish(state(r)); return state(r);
  }
  function browsersInScope(context) {
    const root = resolve(context.workspacePath || ".");
    return [...resources.values()].filter(
      (r) =>
        r.view &&
        !r.closed &&
        r.taskId === context.taskId &&
        resolve(r.workspacePath || ".") === root,
    );
  }
  function adoptBrowser(context) {
    const list = browsersInScope(context);
    if (!list.length) return null;
    const preferred = list.find((r) => r.id === visibleId) || list.at(-1);
    preferred.claimForAgent?.();
    return preferred;
  }
  function acquire(context) {
    const ownedBrowsers = new Map();
    const lazy = (ownerId = "main") => {
      let r = ownedBrowsers.get(ownerId);
      if (r && !r.closed) return r;
      r = ownerId === "main" ? adoptBrowser(context) : null;
      if (!r) r = browser(context, "agent");
      ownedBrowsers.set(ownerId, r);
      return r;
    };
    const facade = (ownerId) => Object.fromEntries(["open", "snapshot", "click", "fill", "press", "screenshot", "console", "network", "close"].map((method) => [method, (...args) => lazy(ownerId)[method](...args)]));
    const browserRuntime = { ...facade("main"), forOwner: facade };
    let released = false;
    const manager = createPersistentProcessManager({ emit: (event) => {
      if (!released) context.emit(event);
      if (!event.processId) return;
      if (event.type === "process.started") {
        const r = { ...context, id: event.processId, kind: "process", title: event.command, cwd: event.cwd, status: event.status, owner: "agent",
          keepAlive: false, present: false, manager, close: () => manager.kill(event.processId) };
        resources.set(r.id, r); publish(state(r));
      } else if (event.type === "process.exited") {
        const r = resources.get(event.processId);
        if (r) { r.status = event.status; r.exitCode = event.exitCode; publish(state(r)); }
      }
    } });
    const presentFile = (path, line = 1) => {
      const normalized = String(path || "").replaceAll("\\", "/").replace(/^\.\//, "");
      if (!normalized || normalized.length > 1000 || /[\u0000-\u001f]/.test(normalized)) return;
      publish({
        id: `file:${normalized}`,
        kind: "file",
        path: normalized,
        title: normalized.split("/").at(-1),
        line: Math.max(1, Number(line) || 1),
        taskId: context.taskId,
        workspacePath: context.workspacePath,
        owner: "agent",
        status: "ready",
        present: true,
      });
    };
    const presentProcess = (processId) => {
      const r = resources.get(processId);
      if (!r || r.kind !== "process" || r.manager !== manager) return;
      r.present = true;
      publish(state(r));
    };
    const presentBrowsers = () => {
      for (const r of browsersInScope(context)) {
        if (r.closed) continue;
        r.present = true;
        r.changed();
      }
    };
    const presentRunningProcesses = () => {
      for (const r of resources.values()) {
        if (r.manager !== manager || r.status !== "running") continue;
        r.present = true;
        publish(state(r));
      }
    };
    return {
      browserRuntime,
      processManager: manager,
      present: {
        file: presentFile,
        process: presentProcess,
        browser: presentBrowsers,
        live() {
          presentBrowsers();
          presentRunningProcesses();
        },
      },
      async release({ aborted } = {}) {
        released = true;
        for (const r of ownedBrowsers.values()) {
          if (r.closed) continue;
          if (aborted && r.owner !== "user") await r.close();
          else await r.takeover();
        }
        for (const r of resources.values()) if (r.manager === manager) {
          if (aborted && !r.keepAlive) await r.close();
          else { r.owner = "user"; r.keepAlive = true; publish(state(r)); }
        }
      },
    };
  }
  async function request(input = {}) {
    if (!input.taskId || typeof input.taskId !== "string" || input.taskId.length > 200) throw new Error("缺少任务标识。");
    const context = { taskId: input.taskId, workspacePath: String(input.workspacePath || "") };
    if (input.action === "list") {
      const root = resolve(context.workspacePath || ".");
      return [...resources.values()]
        .filter((r) => r.taskId === context.taskId && resolve(r.workspacePath || ".") === root)
        .map(state);
    }
    if (input.action === "file") return readWorkbenchFile(context.workspacePath, input.path, {
      authorizeExternal: input.approveExternal === true ? confirmExternalRead : undefined,
    });
    if (input.action === "search") return searchWorkbenchFiles(context.workspacePath, input.query);
    if (input.action === "new-browser") return browser(context).state();
    if (input.action === "new-terminal") return terminal(context);
    if (input.action === "hide") { hide(input.generation); return true; }
    const r = scope(resources.get(input.id), context);
    if (!r) return { missing: true };
    if (input.action === "stop") {
      if (visibleId === r.id) hide();
      await r.close();
      if (r.view) getWindow()?.contentView.removeChildView(r.view);
      // Keep stopped logs readable until their tab is explicitly closed.
      if (r.view || input.dispose === true) resources.delete(r.id);
      return state(r);
    }
    if (input.action === "interrupt") {
      if (r.owner !== "user" || r.kind !== "terminal" || r.status !== "running") throw new Error("终端不可中断。");
      r.child.write("\x03"); return true;
    }
    if (input.action === "keep") { r.keepAlive = Boolean(input.value); publish(state(r)); return state(r); }
    if (input.action === "read") {
      if (r.kind === "process") return r.manager.read({ processId: r.id, cursor: input.cursor, maxChars: 80000 });
      if (r.kind !== "terminal") throw new Error("不是终端。");
      const start = Math.max(0, Number(input.cursor || 0) - r.offset);
      const output = r.output.slice(start, start + 80000);
      return { ...state(r), output, cursor: r.offset + start + output.length, cursorExpired: Number(input.cursor || 0) < r.offset };
    }
    if (input.action === "write") {
      if (r.owner !== "user" || r.kind !== "terminal" || r.status !== "running" || typeof input.data !== "string" || input.data.length > 64000) throw new Error("终端不可输入。");
      r.child.write(input.data); return true;
    }
    if (input.action === "resize-terminal") {
      if (r.kind !== "terminal" || r.status !== "running") return false;
      r.child.resize(Math.max(20, Math.min(300, Math.round(input.cols) || 80)), Math.max(5, Math.min(150, Math.round(input.rows) || 24))); return true;
    }
    if (!r.view || r.closed) return { missing: true };
    if (input.action === "layout") {
      if (input.visible === false) {
        hide(input.generation);
        return false;
      }
      const token = acceptLayoutGeneration(input.generation, acceptedGeneration);
      if (Number.isFinite(Number(input.generation)) && !token.apply) return false;
      if (Number.isFinite(Number(input.generation))) acceptedGeneration = token.accepted;
      const epoch = hideEpoch;
      hideView(resources.get(visibleId));
      visibleId = null;
      const win = getWindow();
      if (!win) return false;
      const z = win.webContents.getZoomFactor(); const [w, h] = win.getContentSize();
      const box = input.rect || {}; const vals = ["x", "y", "width", "height"].map((k) => Number(box[k]) * z);
      if (!vals.every(Number.isFinite) || vals[2] < 1 || vals[3] < 1) throw new Error("无效视图尺寸。");
      const x = Math.max(0, Math.min(w - 1, Math.round(vals[0]))), y = Math.max(0, Math.min(h - 1, Math.round(vals[1])));
      const bounds = { x, y, width: Math.max(1, Math.min(w - x, Math.round(vals[2]))), height: Math.max(1, Math.min(h - y, Math.round(vals[3]))) };
      if (!attachView(r, bounds)) return false;
      await r.ready.catch(() => undefined);
      if (epoch !== hideEpoch || r.closed) {
        hideView(r);
        return false;
      }
      if (Number.isFinite(Number(input.generation))) {
        const latest = acceptLayoutGeneration(input.generation, acceptedGeneration);
        if (!latest.apply) {
          hideView(r);
          return false;
        }
      }
      await r.setViewport(bounds.width, bounds.height);
      if (epoch !== hideEpoch || r.closed) {
        hideView(r);
        return false;
      }
      if (!revealView(r, bounds)) return false;
      visibleId = r.id;
      return bounds;
    }
    if (input.action === "takeover") return r.takeover();
    if (input.action === "release") { await r.release(); return r.state(); }
    if (input.action === "navigate") return r.userNavigate(input.url);
    if (input.action === "console") return { entries: r.entries, network: r.problems };
    if (input.action === "history") {
      if (r.owner !== "user") throw new Error("请先接管浏览器。");
      if (input.direction === "back" && r.wc.navigationHistory.canGoBack()) r.wc.navigationHistory.goBack();
      if (input.direction === "forward" && r.wc.navigationHistory.canGoForward()) r.wc.navigationHistory.goForward();
      if (input.direction === "reload") r.wc.reload();
      return true;
    }
    throw new Error("未知工作台操作。");
  }
  return { request, acquire, hide, resources, async closeAll() { hide(); await Promise.all([...resources.values()].map((r) => r.close())); resources.clear(); } };
}

export function registerWorkbench(getWindow) {
  const service = createWorkbenchService({ getWindow });
  installWorkbenchProvider(service);
  ipcMain.handle("workbench:request", (event, input) => {
    if (event.sender !== getWindow()?.webContents || event.senderFrame !== getWindow()?.webContents.mainFrame) throw new Error("Untrusted workbench sender.");
    return Promise.resolve(service.request(input)).catch((error) => {
      if (String(error?.message || "").includes("不属于当前任务")) return { missing: true };
      throw error;
    });
  });
  app.on("before-quit", () => { void service.closeAll(); });
  return service;
}

import { WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isAllowedBrowserNavigation,
  isNavigationAbort,
  navigationTarget,
  normalizeBrowserUrl,
} from "../browser-url.js";

// Executed in an isolated world. No node, preload, arbitrary scripts or IPC from callers.
function inspectPage(input = {}, operation = "snapshot") {
  const visible = (el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
  const roleOf = (el) => el.getAttribute("role") || ({ BUTTON: "button", A: "link", TEXTAREA: "textbox",
    SELECT: "combobox", IMG: "img" }[el.tagName]) || (el.tagName === "INPUT" ? (el.type === "checkbox" ? "checkbox" : "textbox") : "");
  const labelOf = (el) => el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") || "").split(" ").map((id) => document.getElementById(id)?.textContent || "").join(" ").trim() ||
    [...(el.labels || [])].map((l) => l.textContent).join(" ").trim() || el.getAttribute("alt") || el.textContent?.trim() || "";
  if (operation === "snapshot") {
    const elements = [...document.querySelectorAll("button,a,input,textarea,select,[role]")].filter(visible).slice(0, 250);
    return { title: document.title, url: location.href, visibleText: (document.body?.innerText || "").slice(0, 14000),
      ariaSnapshot: elements.map((el) => `- ${roleOf(el)} "${labelOf(el).slice(0, 160)}"`).join("\n"),
      viewport: { width: innerWidth, height: innerHeight }, privateValuesOmitted: true };
  }
  let matches;
  if (input.selector) matches = [...document.querySelectorAll(input.selector)];
  else {
    matches = [...document.querySelectorAll("body *")].filter((el) => {
      if (input.placeholder) return (el.getAttribute("placeholder") || "").includes(input.placeholder);
      if (input.label) return labelOf(el).includes(input.label) && /INPUT|TEXTAREA|SELECT/.test(el.tagName);
      if (input.role) return roleOf(el) === input.role && (!input.name || labelOf(el).includes(input.name));
      if (input.text) return (el.textContent || "").includes(input.text) && ![...el.children].some((c) => (c.textContent || "").includes(input.text));
      return false;
    });
  }
  const el = matches.find(visible);
  if (!el) return { found: false };
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  const rect = el.getBoundingClientRect();
  const x = Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2));
  const y = Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2));
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(el === hit || el.contains(hit))) return { found: false, obscured: true };
  if (el.disabled) return { found: false, disabled: true };
  if (operation === "focus") el.focus({ preventScroll: true });
  if (operation === "click") el.click();
  if (operation === "fill") {
    if (el.readOnly || (!/INPUT|TEXTAREA/.test(el.tagName) && !el.isContentEditable)) throw new Error("Target is not editable.");
    el.focus({ preventScroll: true });
    if (el.isContentEditable) el.textContent = input.value;
    else {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, input.value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { found: true, x, y };
}

export class WorkbenchBrowserSession {
  constructor({ taskId, workspacePath, owner = "user", publish = () => {} }) {
    this.id = `browser_${randomUUID()}`;
    this.kind = "browser";
    this.taskId = taskId; this.workspacePath = workspacePath; this.owner = owner;
    this.publish = publish; this.entries = []; this.problems = [];
    this.status = "ready"; this.pending = Promise.resolve(); this.action = ""; this.closed = false; this.agentUsed = owner === "agent";
    this.view = new WebContentsView({ webPreferences: {
      partition: `workbench-${randomUUID()}`, nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, backgroundThrottling: false,
    } });
    this.wc = this.view.webContents;
    this.wc.session.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
    this.wc.session.setPermissionCheckHandler(() => false);
    this.wc.session.on("will-download", (event) => { event.preventDefault(); this.note("download", "自动下载已阻止；请通过明确的文件下载流程。"); });
    this.wc.setWindowOpenHandler(({ url }) => {
      try {
        const next = normalizeBrowserUrl(url);
        queueMicrotask(() => {
          void this.loadPage(next).catch((error) => this.note("error", error.message));
        });
      } catch {
        this.note("popup", `弹出页已阻止：${String(url || "").slice(0, 500)}`);
      }
      return { action: "deny" };
    });
    const guard = (event, url) => {
      if (!isAllowedBrowserNavigation(navigationTarget(event, url))) event.preventDefault();
    };
    this.wc.on("will-navigate", guard);
    this.wc.on("will-redirect", guard);
    this.wc.on("console-message", (event) => {
      this.note(event.level || "info", event.message || "");
    });
    this.wc.on("did-fail-load", (_e, code, description) => { if (code !== -3) this.note("error", description); });
    this.wc.on("did-navigate", () => { this.changed(); void this.applyViewport(); });
    this.wc.on("did-navigate-in-page", () => this.changed());
    this.wc.on("page-title-updated", () => this.changed());
    this.wc.on("render-process-gone", (_event, details) => { this.status = "crashed"; this.note("error", details.reason); });
    this.wc.debugger.on("message", (_e, method, params) => {
      if (method === "Network.responseReceived" && params.response.status >= 400) {
        this.problems.push({ url: params.response.url, status: params.response.status }); this.problems = this.problems.slice(-60);
      }
    });
    // Chromium needs a committed frame before debugger/Emulation commands.
    // Attaching on a newly constructed WebContentsView can crash GPU/renderer.
    // Agent tools can run before the sidebar is laid out; never inspect at 1×1.
    this.metrics = { width: 1024, height: 768 };
    this.ready = this.wc.loadURL("about:blank").then(async () => {
      if (!this.ensureDebugger()) return;
      await this.wc.debugger.sendCommand("Network.enable").catch((e) => this.note("error", e.message));
      return this.applyViewport();
    });
    // A user cannot type/click the agent-owned native view by accident.
    this.wc.on("before-input-event", (event) => { if (this.owner !== "user" && !this.dispatchingInput) event.preventDefault(); });
    this.wc.on("before-mouse-event", (event) => { if (this.owner !== "user" && !this.dispatchingInput) event.preventDefault(); });
    this.view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  }
  get active() { return !this.closed; }
  ensureDebugger() {
    if (this.closed || this.wc.isDestroyed()) return false;
    try {
      if (!this.wc.debugger.isAttached()) this.wc.debugger.attach("1.3");
      return this.wc.debugger.isAttached();
    } catch (error) {
      this.note("error", error.message);
      return false;
    }
  }
  applyViewport() {
    if (!this.metrics.width || !this.metrics.height || this.closed || !this.ensureDebugger()) return Promise.resolve();
    return this.wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: this.metrics.width,
      height: this.metrics.height,
      deviceScaleFactor: 1,
      mobile: false,
    }).catch((error) => this.note("error", error.message));
  }
  setViewport(width, height) {
    this.metrics = {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    };
    return this.applyViewport();
  }
  state() { return { id: this.id, kind: "browser", taskId: this.taskId, workspacePath: this.workspacePath,
    title: this.closed ? "已结束的浏览器" : this.wc.getTitle() || "Browser", url: this.closed ? "" : this.wc.getURL(),
    owner: this.owner, agentUsed: Boolean(this.agentUsed), status: this.closed ? "closed" : this.status, action: this.action,
    present: Boolean(this.present) }; }
  changed() { this.publish(this.state()); }
  claimForAgent() {
    this.agentUsed = true;
    if (this.owner === "handoff") return this;
    if (this.owner !== "agent") {
      this.owner = "agent";
      this.action = "";
      this.changed();
    }
    return this;
  }
  note(type, text) { this.entries.push({ type, text: String(text).slice(0, 2000) }); this.entries = this.entries.slice(-100); this.changed(); }
  evaluate(input, operation) {
    if (this.closed) throw new Error("Browser session has ended.");
    return this.wc.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${inspectPage.toString()})(${JSON.stringify(input)},${JSON.stringify(operation)})` }]);
  }
  async locate(input, operation = "locate") {
    if (!["selector", "role", "label", "placeholder", "text"].some((k) => input[k])) throw new Error("A browser locator is required.");
    const deadline = Date.now() + 7000;
    do {
      if (this.closed) throw new Error("Browser session has ended.");
      const result = await this.evaluate(input, operation);
      if (result.found) return result;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < deadline);
    throw new Error("No visible, enabled and unobscured element matched the locator.");
  }
  async snapshot() {
    await this.ready;
    if (this.owner === "user" || this.owner === "handoff") throw new Error("BROWSER_USER_CONTROL: User is operating privately. Wait for control to be returned, then take a fresh snapshot.");
    return { active: true, browser: "AporiaX Workbench", browserSessionId: this.id,
      ...(await this.evaluate({}, "snapshot")), consoleErrors: this.entries.slice(-20), networkProblems: this.problems.slice(-20) };
  }
  async mentionSnapshot() {
    // A one-shot user-selected reference does not transfer browser control.
    await this.ready;
    const page = await this.evaluate({}, "snapshot");
    return { source: "explicit-browser-mention", browserSessionId: this.id, ...page };
  }
  async actionRun(name, fn) {
    if (this.owner !== "agent") throw new Error("BROWSER_USER_CONTROL: User has this browser. Do other work until control returns; do not retry this action repeatedly.");
    const run = this.pending.then(async () => {
      await this.ready;
      if (this.owner !== "agent") throw new Error("BROWSER_USER_CONTROL: Browser handoff is pending.");
      this.action = name; this.changed();
      try { return await fn(); } finally { this.action = ""; this.changed(); }
    });
    this.pending = run.catch(() => undefined);
    return run;
  }
  async loadPage(url) {
    try {
      await this.wc.loadURL(url);
    } catch (error) {
      if (!isNavigationAbort(error)) throw error;
    }
    return this.wc.getURL();
  }
  async open(input) { return this.actionRun("正在导航", async () => { await this.loadPage(normalizeBrowserUrl(input.url)); return this.snapshot(); }); }
  async click(input) { return this.actionRun("正在点击", async () => {
    // Semantic DOM activation also works while the native view is hidden.
    // Unlike Playwright this is not a trusted OS click; file pickers/popups stay blocked.
    await this.locate(input, "click");
    return this.snapshot();
  }); }
  async fill(input) { return this.actionRun("正在输入", async () => {
    if (typeof input.value !== "string" || input.value.length > 20000) throw new Error("Invalid fill value.");
    await this.locate(input, "fill"); return this.snapshot();
  }); }
  async press(input) { return this.actionRun("正在按键", async () => {
    if (["selector", "role", "label", "placeholder", "text"].some((k) => input[k])) await this.locate(input, "focus");
    const parts = String(input.key || "").split("+"); const key = parts.pop();
    const modifiers = (parts.includes("Alt") ? 1 : 0) | (parts.includes("Control") ? 2 : 0) | (parts.includes("Meta") ? 4 : 0) | (parts.includes("Shift") ? 8 : 0);
    const keyCode = ({ Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Space: 32 })[key] || (key?.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    if (!keyCode) throw new Error("Unsupported browser key.");
    this.dispatchingInput = true;
    try {
    await this.wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key, windowsVirtualKeyCode: keyCode, modifiers,
      ...(key === "Enter" ? { text: "\r" } : key.length === 1 && !modifiers ? { text: key } : {}) });
    await this.wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: keyCode, modifiers });
    } finally { this.dispatchingInput = false; }
    return this.snapshot();
  }); }
  async screenshot(input = {}) { return this.actionRun("正在截图", async () => {
    const dir = join(tmpdir(), "aporiax-browser"); await mkdir(dir, { recursive: true });
    const path = join(dir, `${this.id}-${Date.now()}.png`);
    const { data } = await this.wc.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: Boolean(input.full_page) });
    await writeFile(path, Buffer.from(data, "base64"));
    return { path, temporary: true, browserSessionId: this.id, url: this.wc.getURL() };
  }); }
  console() { return this.owner === "agent" ? { entries: this.entries } : { entries: [], paused: true }; }
  network() { return this.owner === "agent" ? { entries: this.problems } : { entries: [], paused: true }; }
  async takeover() {
    this.owner = "handoff"; this.changed();
    await this.pending; this.owner = "user"; this.changed(); return this.state();
  }
  async release() { this.entries = []; this.problems = []; this.owner = "agent"; this.changed(); return this.snapshot(); }
  async userNavigate(url) {
    if (this.owner !== "user") throw new Error("请先接管浏览器。");
    await this.ready;
    await this.loadPage(normalizeBrowserUrl(url));
    this.changed();
    return this.state();
  }
  async close() {
    if (this.closed) return { closed: true };
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (!this.wc.isDestroyed()) {
        this.wc.setAudioMuted(true);
        this.view.setVisible(false);
        await new Promise((done, reject) => {
          const finish = () => { clearTimeout(timer); done(); };
          const timer = setTimeout(() => {
            this.wc.removeListener("destroyed", finish);
            reject(new Error("浏览器关闭超时，请重试。"));
          }, 5000);
          this.wc.once("destroyed", finish);
          try { this.wc.close({ waitForBeforeUnload: false }); }
          catch (error) { clearTimeout(timer); this.wc.removeListener("destroyed", finish); reject(error); }
        });
      }
      this.closed = true; this.status = "closed";
      this.changed(); return { closed: true };
    })().catch((error) => { this.closing = null; throw error; });
    return this.closing;
  }
}

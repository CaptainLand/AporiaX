export const BUILTINS = ["route", "workspace", "understanding"];
export const TAB_KINDS = [
  "sidechat",
  "git",
  "route",
  "workspace",
  "understanding",
  "file",
  "image",
  "browser",
  "terminal",
  "process",
];
export const SESSION_TAB_KINDS = new Set(["browser", "terminal", "process"]);
export const DEFAULT_WIDTH = 520;
export const MIN_WIDTH = 360;
export const MIN_DIALOGUE_WIDTH = 420;
export const MAX_WIDTH = 1600;

export function clampWorkbenchWidth(width, available) {
  const requested = Number(width);
  const size = Number.isFinite(requested) ? requested : DEFAULT_WIDTH;
  const room = Number(available);
  const maxByChat = Number.isFinite(room)
    ? Math.max(0, room - MIN_DIALOGUE_WIDTH)
    : MAX_WIDTH;
  const maxWidth = Math.min(MAX_WIDTH, maxByChat);
  if (maxWidth <= MIN_WIDTH) return maxWidth;
  return Math.min(maxWidth, Math.max(MIN_WIDTH, size));
}

export const drafts = new Map();

export function canonicalPath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function sameWorkspace(left, right) {
  return canonicalPath(left) === canonicalPath(right);
}

export function sameScope(resource, task) {
  return (
    resource?.taskId === task?.id &&
    sameWorkspace(resource?.workspacePath, task?.workspacePath || "")
  );
}

export function scopeKey(task) {
  const account = task?.accountId || task?.userId || "";
  return `aporiax.workbench.v1:${encodeURIComponent(account)}:${encodeURIComponent(task?.workspacePath || "")}:${encodeURIComponent(task?.id || "")}`;
}

function normalizeTab(tab) {
  if (!tab || typeof tab.id !== "string" || !TAB_KINDS.includes(tab.kind)) {
    return null;
  }
  const next = {
    id: tab.id.slice(0, 500),
    kind: tab.kind,
    title: String(tab.title || tab.kind).slice(0, 160),
  };
  if (tab.kind === "file") {
    next.path = String(tab.path || "").replaceAll("\\", "/").slice(0, 1000);
    next.line = Math.max(1, Number(tab.line) || 1);
    next.revision = Math.max(0, Number(tab.revision) || 0);
    if (!next.path) return null;
  }
  if (tab.kind === "image") {
    const src = String(tab.src || "");
    if (!/^(data:image\/(?:png|jpeg|webp|gif);base64,|aporiax-blob:\/\/[a-f0-9]{64}$|https?:\/\/)/i.test(src) || src.length > 24000000) return null;
    next.src = src;
  }
  return next;
}

export function normalizeLayout(raw = {}) {
  const seen = new Set();
  const tabs = [];
  for (const item of Array.isArray(raw.tabs) ? raw.tabs : []) {
    const tab = normalizeTab(item);
    if (!tab || seen.has(tab.id)) continue;
    seen.add(tab.id);
    tabs.push(tab);
    if (tabs.length >= 40) break;
  }
  const closed = [
    ...new Set(
      (Array.isArray(raw.closed) ? raw.closed : [])
        .filter((id) => typeof id === "string" && !seen.has(id))
        .map((id) => id.slice(0, 500)),
    ),
  ].slice(-80);
  return {
    tabs,
    active: tabs.some((tab) => tab.id === raw.active) ? raw.active : tabs[0]?.id || null,
    open: Boolean(raw.open),
    dock: "right",
    width: clampWorkbenchWidth(raw.width),
    follow: raw.follow !== false,
    closed,
  };
}

export function loadLayout(key) {
  try {
    return normalizeLayout(JSON.parse(localStorage.getItem(key) || "{}"));
  } catch {
    return normalizeLayout();
  }
}

export function persistableLayout(layout) {
  const next = normalizeLayout(layout);
  return {
    // Inline attachments can be large; their bytes already live in task history.
    tabs: next.tabs.filter((tab) => tab.kind !== "image" || !tab.src.startsWith("data:")),
    active: next.active,
    open: next.open,
    dock: "right",
    width: next.width,
    follow: next.follow,
    closed: next.closed,
  };
}

export function dropMissingSessionTabs(layout, liveIds) {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds || []);
  const tabs = layout.tabs.filter((tab) => !SESSION_TAB_KINDS.has(tab.kind) || live.has(tab.id));
  if (tabs.length === layout.tabs.length) return layout;
  return {
    ...layout,
    tabs,
    active: tabs.some((tab) => tab.id === layout.active) ? layout.active : tabs.at(-1)?.id || null,
  };
}

export function saveLayout(key, layout) {
  localStorage.setItem(key, JSON.stringify(persistableLayout(layout)));
}

function shouldSelect(layout, tab, automatic) {
  if (!automatic) return true;
  if (!layout.follow) return false;
  if (!layout.open || !layout.active) return true;
  const current = layout.tabs.find((item) => item.id === layout.active);
  return ["browser", "process", "terminal"].includes(current?.kind);
}

export function openTab(layout, tab, { automatic = false, force = false } = {}) {
  const nextTab = normalizeTab(tab);
  if (!nextTab) return layout;
  const closed = (layout.closed || []).filter((id) => id !== nextTab.id);
  const existing = layout.tabs.some((item) => item.id === nextTab.id);
  if (automatic && !force && !existing && (layout.closed || []).includes(nextTab.id)) {
    return layout;
  }
  const tabs = existing
    ? layout.tabs.map((item) => (item.id === nextTab.id ? { ...item, ...nextTab } : item))
    : [...layout.tabs, nextTab];
  const select = force || shouldSelect(layout, nextTab, automatic);
  return {
    ...layout,
    tabs,
    closed,
    active: select ? nextTab.id : layout.active,
    open: select ? true : layout.open,
  };
}

export function closeTab(layout, id) {
  const tabs = layout.tabs.filter((tab) => tab.id !== id);
  const closed = [...new Set([...(layout.closed || []), id])].slice(-80);
  return {
    ...layout,
    tabs,
    closed,
    active: layout.active === id ? tabs.at(-1)?.id || null : layout.active,
  };
}

export function moveTab(layout, id, beforeId) {
  const tab = layout.tabs.find((item) => item.id === id);
  if (!tab) return layout;
  const next = layout.tabs.filter((item) => item.id !== id);
  const index = next.findIndex((item) => item.id === beforeId);
  next.splice(index < 0 ? next.length : index, 0, tab);
  return { ...layout, tabs: next };
}

export function setFollow(layout, follow) {
  return { ...layout, follow: Boolean(follow) };
}

export function draftKey(scope, id) {
  return `${scope}:${id}`;
}

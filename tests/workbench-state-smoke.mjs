import assert from "node:assert/strict";
import {
  clampWorkbenchWidth,
  closeTab,
  dropMissingSessionTabs,
  loadLayout,
  MIN_DIALOGUE_WIDTH,
  MIN_WIDTH,
  normalizeLayout,
  openTab,
  persistableLayout,
  sameScope,
  sameWorkspace,
  scopeKey,
} from "../src/workbench/state.js";

const empty = normalizeLayout();
assert.equal(empty.dock, "right");
assert.equal(empty.follow, true);
assert.deepEqual(empty.closed, []);

const restored = normalizeLayout({
  tabs: [
    { id: "route", kind: "route", title: "Route" },
    { id: "route", kind: "route", title: "dup" },
    { id: "bad", kind: "unknown" },
    { id: "file:a", kind: "file", path: "D:\\Agent开发\\src\\main.jsx", line: 12 },
  ],
  active: "missing",
  dock: "bottom",
  width: 80,
  follow: false,
  closed: ["gone", "file:a"],
  maximized: true,
});
assert.equal(restored.tabs.length, 2);
assert.equal(restored.active, "route");
assert.equal(restored.dock, "right");
assert.equal(restored.width, 360);
assert.equal(restored.follow, false);
assert.equal(restored.tabs[1].path.includes("\\"), false);
assert.ok(!restored.closed.includes("file:a"));

let layout = openTab(empty, { id: "browser_1", kind: "browser", title: "Browser" });
assert.equal(layout.active, "browser_1");
assert.equal(layout.open, true);
layout = closeTab(layout, "browser_1");
assert.deepEqual(layout.tabs, []);
assert.ok(layout.closed.includes("browser_1"));
const ignored = openTab(layout, { id: "browser_1", kind: "browser", title: "Browser" }, { automatic: true });
assert.equal(ignored.tabs.length, 0);
const forced = openTab(layout, { id: "browser_1", kind: "browser", title: "Browser" }, { automatic: true, force: true });
assert.equal(forced.tabs.length, 1);
assert.equal(forced.active, "browser_1");
const reopened = openTab(layout, { id: "browser_1", kind: "browser", title: "Browser" });
assert.equal(reopened.tabs.length, 1);
assert.ok(!reopened.closed.includes("browser_1"));

layout = openTab(empty, { id: "file:x", kind: "file", path: "src/a.js", title: "a.js" });
layout = { ...layout, follow: false };
const later = openTab(layout, { id: "browser_2", kind: "browser", title: "Browser" }, { automatic: true });
assert.equal(later.active, "file:x");
assert.equal(later.tabs.length, 2);
const presented = openTab(
  later,
  { id: "file:docs/report.docx", kind: "file", path: "docs/report.docx", title: "report.docx", revision: 2 },
  { automatic: true, force: true },
);
assert.equal(presented.active, "file:docs/report.docx");
assert.equal(presented.open, true);
assert.equal(presented.tabs.at(-1).revision, 2);

assert.equal(sameWorkspace("D:\\Work\\A", "D:/Work/A/"), true);
assert.equal(
  sameScope({ taskId: "t1", workspacePath: "D:\\Work" }, { id: "t1", workspacePath: "D:/Work" }),
  true,
);
assert.equal(
  sameScope({ taskId: "t1", workspacePath: "D:\\Work" }, { id: "t2", workspacePath: "D:/Work" }),
  false,
);
assert.notEqual(
  scopeKey({ id: "t1", workspacePath: "W", accountId: "a" }),
  scopeKey({ id: "t1", workspacePath: "W", accountId: "b" }),
);

assert.equal(clampWorkbenchWidth(800, 1400), 800);
assert.equal(clampWorkbenchWidth(1200, 900), 900 - MIN_DIALOGUE_WIDTH);
assert.equal(clampWorkbenchWidth(200, 1400), MIN_WIDTH);
assert.equal(clampWorkbenchWidth(520, 600), 600 - MIN_DIALOGUE_WIDTH);

const stored = persistableLayout({ ...reopened, dock: "bottom", width: 700 });
assert.equal(stored.dock, "right");
assert.equal(stored.width, 700);

const withSessions = normalizeLayout({
  tabs: [
    { id: "route", kind: "route", title: "Route" },
    { id: "browser_old", kind: "browser", title: "Browser" },
    { id: "terminal_live", kind: "terminal", title: "终端" },
    { id: "file:a", kind: "file", path: "src/a.js", title: "a.js" },
  ],
  active: "browser_old",
});
const pruned = dropMissingSessionTabs(withSessions, ["terminal_live"]);
assert.equal(pruned.tabs.map((tab) => tab.id).join(","), "route,terminal_live,file:a");
assert.equal(pruned.active, "file:a");
assert.equal(dropMissingSessionTabs(withSessions, ["browser_old", "terminal_live"]), withSessions);

const memory = globalThis.localStorage;
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) || null,
  setItem: (key, value) => store.set(key, String(value)),
};
try {
  const first = loadLayout("k");
  assert.equal(first.open, false);
} finally {
  if (memory) globalThis.localStorage = memory;
  else delete globalThis.localStorage;
}

console.log("workbench state smoke: PASS");

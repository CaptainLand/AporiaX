import assert from "node:assert/strict";
import {
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_RISKS,
  hasBrowserLocator,
  isBrowserToolName,
  normalizeBrowserUrl,
} from "../electron/browser-runtime.js";
import { createPermissionPolicy, getToolPermission } from "../electron/agent-core.js";

const names = BROWSER_TOOL_DEFINITIONS.map((definition) => definition.function.name);
assert.deepEqual(names, [
  "browser_open",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_press",
  "browser_screenshot",
  "browser_console",
  "browser_network",
  "browser_close",
]);
assert(names.every(isBrowserToolName));
assert.equal(BROWSER_TOOL_RISKS.browser_snapshot, "read");
assert.equal(BROWSER_TOOL_RISKS.browser_click, "control");
assert.equal(BROWSER_TOOL_RISKS.browser_fill, "control");

assert.equal(normalizeBrowserUrl("https://example.com/path"), "https://example.com/path");
assert.equal(normalizeBrowserUrl("http://127.0.0.1:5173"), "http://127.0.0.1:5173/");
assert.throws(() => normalizeBrowserUrl("file:///etc/passwd"), /only allows http and https/i);
assert.throws(() => normalizeBrowserUrl("javascript:alert(1)"), /only allows http and https/i);
assert.throws(() => normalizeBrowserUrl("https://user:pass@example.com"), /Credentials embedded/i);

assert.equal(hasBrowserLocator({ role: "button", name: "Save" }), true);
assert.equal(hasBrowserLocator({ label: "Email" }), true);
assert.equal(hasBrowserLocator({}), false);

const readOnly = createPermissionPolicy("read-only");
assert.equal(getToolPermission(readOnly, "browser_open"), "allow");
assert.equal(getToolPermission(readOnly, "browser_snapshot"), "allow");
assert.equal(getToolPermission(readOnly, "browser_click"), "deny");

const write = createPermissionPolicy("workspace-write");
assert.equal(getToolPermission(write, "browser_open"), "allow");
assert.equal(getToolPermission(write, "browser_snapshot"), "allow");
assert.equal(getToolPermission(write, "browser_click"), "ask");
assert.equal(getToolPermission(write, "browser_fill"), "ask");
assert.equal(getToolPermission(write, "browser_press"), "ask");

const builder = createPermissionPolicy("builder-write");
assert.equal(getToolPermission(builder, "browser_open"), "deny");
assert.equal(getToolPermission(builder, "browser_click"), "deny");

console.log("browser runtime smoke: PASS");

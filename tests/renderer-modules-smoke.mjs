import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const main = await readFile("src/main.jsx", "utf8");

for (const definition of [
  "function Composer(",
  "function Conversation(",
  "function RouteView(",
  "function SettingsPanel(",
  "function ModelChoice(",
  "function SegmentedControl(",
  "function Switch(",
]) {
  assert.doesNotMatch(
    main,
    new RegExp(definition.replace(/[()]/g, "\\$&")),
    `${definition} should live outside main.jsx`,
  );
}

assert.match(main, /from "\.\/composer\/Composer\.jsx"/);
assert.match(main, /from "\.\/conversation\/ConversationViews\.jsx"/);
assert.match(main, /from "\.\/workbench\/WorkbenchLayout\.jsx"/);
assert.match(main, /from "\.\/workbench\/use-workbench\.js"/);
assert.match(main, /coverBrowser=\{applicationSettingsOpen \|\| newTaskOpen\}/);
assert.match(main, /overlaying=\{coverBrowser \|\| settingsOpen/);
assert.match(main, /from "\.\/settings\/SettingsPanel\.jsx"/);
assert.match(main, /from "\.\/components\/Controls\.jsx"/);
assert.match(main, /from "\.\/models\/model-catalog\.js"/);

for (const path of [
  "src/composer/Composer.jsx",
  "src/conversation/ConversationViews.jsx",
  "src/settings/SettingsPanel.jsx",
  "src/components/Controls.jsx",
  "src/models/model-catalog.js",
  "src/workbench/WorkbenchLayout.jsx",
  "src/workbench/CollapsedDropRail.jsx",
  "src/workbench/state.js",
  "src/settings/AppUpdateControls.jsx",
]) {
  await access(path);
}

const conversation = await readFile(
  "src/conversation/ConversationViews.jsx",
  "utf8",
);
assert.match(conversation, /export function Conversation\(/);
assert.match(conversation, /export function RouteView\(/);
assert.match(conversation, /useWorkbenchContext/);
assert.match(conversation, /remarkAutolinkBoundary/);
assert.match(conversation, /kind === "anchor-restore"/);

const composer = await readFile("src/composer/Composer.jsx", "utf8");
assert.match(composer, /export function Composer\(/);
assert.match(composer, /function BuilderCountMenu\(/);
assert.match(composer, /beginComposerAttachmentDrag/);
assert.match(composer, /draggable/);
assert.doesNotMatch(composer, /workbench\?\.expand/);
assert.doesNotMatch(composer, /thread-model-badge/);
assert.doesNotMatch(main, /thread-model-badge/);
assert.match(main, /builderLimit: normalizeBuilderCount\(/);
assert.match(main, /CollapsedDropRail/);
assert.match(main, /buildAnchorRestoreNotice/);
assert.match(main, /from "\.\/settings\/AppUpdateControls\.jsx"/);
assert.match(main, /<AppUpdateControls \/>/);
assert.match(main, /AppUpdateToast/);
assert.match(main, /update\.check\(\{ force: false \}\)/);

const workbenchLayout = await readFile("src/workbench/WorkbenchLayout.jsx", "utf8");
assert.match(workbenchLayout, /if \(overlaying\) void workbench\.hideBrowser\(\)/);
assert.match(workbenchLayout, /presentComposerAttachment/);
assert.match(workbenchLayout, /workbench-drop-ready/);
const workbenchPanes = await readFile("src/workbench/WorkbenchPanes.jsx", "utf8");
assert.match(workbenchPanes, /from "@xterm\/addon-web-links"/);
assert.match(workbenchPanes, /useLayoutEffect\(/);
assert.match(workbenchPanes, /cursorStyle: "block"/);
assert.match(workbenchPanes, /new WebLinksAddon\(/);
assert.match(workbenchPanes, /if \(covered\) \{\s*void workbench\.hideBrowser\(\);/);
assert.match(workbenchPanes, /result === false && attempt < 8/);

const settings = await readFile("src/settings/SettingsPanel.jsx", "utf8");
assert.match(settings, /export function SettingsPanel\(/);

console.log("renderer modules smoke: PASS");

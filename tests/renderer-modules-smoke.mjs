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
assert.match(main, /from "\.\/settings\/SettingsPanel\.jsx"/);
assert.match(main, /from "\.\/components\/Controls\.jsx"/);
assert.match(main, /from "\.\/models\/model-catalog\.js"/);

for (const path of [
  "src/composer/Composer.jsx",
  "src/conversation/ConversationViews.jsx",
  "src/settings/SettingsPanel.jsx",
  "src/components/Controls.jsx",
  "src/models/model-catalog.js",
]) {
  await access(path);
}

const conversation = await readFile(
  "src/conversation/ConversationViews.jsx",
  "utf8",
);
assert.match(conversation, /export function Conversation\(/);
assert.match(conversation, /export function RouteView\(/);

const composer = await readFile("src/composer/Composer.jsx", "utf8");
assert.match(composer, /export function Composer\(/);

const settings = await readFile("src/settings/SettingsPanel.jsx", "utf8");
assert.match(settings, /export function SettingsPanel\(/);

console.log("renderer modules smoke: PASS");

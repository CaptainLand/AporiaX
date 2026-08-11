import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "src/state/task-store-core.js",
  "src/state/useTaskStore.js",
  "src/state/harness-event-reducer.js",
  "src/hooks/useHarnessEvents.js",
  "src/conversation/ConversationViews.jsx",
  "src/composer/Composer.jsx",
  "electron/runtime/provider-stream.js",
  "electron/runtime/conversation.js",
  "electron/runtime/native-tool-catalog.js",
  "electron/runtime/tool-permissions.js",
  "electron/runtime/tool-dispatcher.js",
  "electron/runtime/native-tool-executor.js",
  "electron/runtime/workspace-runtime.js",
  "electron/runtime/self-check-evidence.js",
  "electron/runtime/self-check-coordinator.js",
  "electron/runtime/subagent-model.js",
  "electron/runtime/subagent-loop.js",
  "electron/runtime/turn-coordinator.js",
  "electron/harness/capability-registry.js",
  "electron/harness/capability-presentation.js",
  "electron/harness/extension-policy.js",
];

for (const path of requiredFiles) await access(path);

const index = await readFile("index.html", "utf8");
assert.match(index, /src="\/src\/main\.jsx"/);
assert.doesNotMatch(index, /runtime-ui-enhancements/);
assert.doesNotMatch(index, /live-agent-status\.jsx/);
assert.doesNotMatch(index, /skill-status\.jsx/);
assert.doesNotMatch(index, /prompt-folding\.js/);

const hook = await readFile("src/hooks/useHarnessEvents.js", "utf8");
assert.match(hook, /reduceHarnessTaskEvent/);
assert.match(hook, /event\.capability/);
assert.doesNotMatch(hook, /startsWith\("mcp__"\)/);

const runtime = await readFile("electron/agent-runtime-core.js", "utf8");
assert.match(runtime, /createTurnCoordinator/);
assert.match(runtime, /extensionPolicy = \{\}/);
assert.match(runtime, /browserEnabled/);
assert.match(runtime, /dispatchNativeTool/);
assert.match(runtime, /createSelfCheckCoordinator/);
assert.match(runtime, /runSubagentTask/);

const mainV2 = await readFile("electron/main-v2.js", "utf8");
assert.match(mainV2, /loadExtensionPolicy/);
assert.match(mainV2, /core:extension-policy/);
assert.match(mainV2, /core:set-extension-policy/);
assert.match(mainV2, /extensionSourceEnabled\(policy, "skill"\)/);
assert.match(mainV2, /extensionSourceEnabled\(policy, "mcp"\)/);

const capabilityRegistry = await readFile("electron/harness/capability-registry.js", "utf8");
assert.match(capabilityRegistry, /describeTool/);
assert.match(capabilityRegistry, /presentation/);

const extensions = await readFile("src/settings/ExtensionsSettings.jsx", "utf8");
assert.match(extensions, /setExtensionPolicy/);
assert.match(extensions, /Sources & policy/);
assert.match(extensions, /来源与权限/);

console.log("AporiaX v0.6 architecture freeze: PASS");

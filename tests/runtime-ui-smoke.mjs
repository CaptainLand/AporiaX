import assert from "node:assert/strict";
import {
  formatTaskDuration,
  resolveVisionCapability,
  selectVisibleTask,
} from "../src/runtime-ui-core.js";

assert.equal(formatTaskDuration(8_400), "8.4s");
assert.equal(formatTaskDuration(137_000), "2m 17s");
assert.equal(formatTaskDuration(3_793_000), "1h 3m 13s");

const tasks = [
  {
    id: "task-a",
    title: "市场开发",
    workspaceName: "市场",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", status: "completed" },
    ],
  },
  {
    id: "task-b",
    title: "市场开发",
    workspaceName: "市场",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    messages: [
      { role: "assistant", status: "completed" },
      { role: "assistant", status: "completed" },
    ],
  },
];
assert.equal(
  selectVisibleTask(tasks, {
    title: "市场开发",
    workspace: "市场",
    assistantCount: 2,
  }).id,
  "task-b",
);
assert.equal(
  selectVisibleTask(tasks, {
    title: "市场开发",
    workspace: "市场",
    assistantCount: 3,
  }),
  null,
  "a truncated/stale cache must not be guessed when the visible assistant count differs",
);
assert.equal(
  selectVisibleTask(tasks, {
    title: "市场开发",
    workspace: "市场",
  }).id,
  "task-a",
  "title/workspace fallback remains available when no DOM message count is supplied",
);

const providers = [
  {
    id: "deepseek",
    name: "DeepSeek",
    models: [
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        supportsImages: true,
        nativeSupportsImages: false,
        supportsImageProxy: true,
        visionProxy: {
          providerId: "qwen",
          providerName: "Qwen3.5",
          modelId: "qwen3.5-flash",
          modelName: "qwen3.5-flash",
        },
      },
    ],
  },
  {
    id: "qwen",
    name: "Qwen3.5",
    models: [
      {
        id: "qwen3.5-flash",
        supportsImages: true,
        nativeSupportsImages: true,
        supportsImageProxy: false,
        visionProxy: null,
      },
    ],
  },
];

const proxyCapability = resolveVisionCapability(providers, tasks[0]);
assert.equal(proxyCapability.available, true);
assert.equal(proxyCapability.mode, "proxy");
assert.equal(proxyCapability.mainModelName, "DeepSeek V4 Flash");
assert.equal(proxyCapability.proxy.modelId, "qwen3.5-flash");

const nativeCapability = resolveVisionCapability(providers, {
  providerId: "qwen",
  modelId: "qwen3.5-flash",
});
assert.equal(nativeCapability.available, true);
assert.equal(nativeCapability.mode, "native");
assert.equal(nativeCapability.proxy, null);

const unavailable = resolveVisionCapability(
  [
    {
      id: "deepseek",
      name: "DeepSeek",
      models: [
        {
          id: "deepseek-v4-flash",
          supportsImages: false,
          nativeSupportsImages: false,
          supportsImageProxy: false,
          visionProxy: null,
        },
      ],
    },
  ],
  tasks[0],
);
assert.equal(unavailable.available, false);
assert.equal(unavailable.mode, "none");

console.log("runtime ui smoke: ok");

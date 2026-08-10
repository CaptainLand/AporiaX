import assert from "node:assert/strict";
import {
  appendTaskMessage,
  chooseHydratedTasks,
  createLightweightTaskSnapshot,
  createTaskStore,
  serializeTaskCache,
  updateTaskMessageById,
} from "../src/state/task-store-core.js";

const cached = [
  {
    id: "task-cache",
    messages: [{ id: "cached-a", role: "assistant", content: "cached" }],
  },
];
const desktop = [
  {
    id: "task-desktop",
    messages: [{ id: "desktop-a", role: "assistant", content: "desktop" }],
  },
];

assert.equal(
  chooseHydratedTasks({ desktopLoaded: false, desktopTasks: desktop, cachedTasks: cached })[0].id,
  "task-cache",
);
assert.equal(
  chooseHydratedTasks({ desktopLoaded: true, desktopTasks: desktop, cachedTasks: cached })[0].id,
  "task-desktop",
);
assert.deepEqual(
  chooseHydratedTasks({ desktopLoaded: true, desktopTasks: [], cachedTasks: cached }),
  [],
  "a successful desktop read is authoritative even when empty",
);

const messages = Array.from({ length: 75 }, (_, index) => ({
  id: `m-${index}`,
  role: index % 2 ? "assistant" : "user",
  content: `message-${index}`,
  changes: [{ path: "huge.txt" }],
  attachments: [
    {
      name: "image.png",
      dataUrl: "data:image/png;base64,abc",
      content: "attachment",
    },
  ],
}));
const lightweight = createLightweightTaskSnapshot([
  { id: "task-long", messages, anchorRestores: Array.from({ length: 20 }, (_, i) => i) },
]);
assert.equal(lightweight[0].messages.length, 50);
assert.equal(lightweight[0].messages[0].id, "m-25");
assert.equal(lightweight[0].messages.at(-1).id, "m-74");
assert.equal(lightweight[0].messages[0].changes.length, 0);
assert.equal(lightweight[0].messages[0].attachments[0].dataUrl, undefined);
assert.equal(lightweight[0].anchorRestores.length, 10);

const fullCache = serializeTaskCache([{ id: "small", messages: [] }], {
  maxBytes: 100_000,
});
assert.equal(fullCache.lightweight, false);
assert.equal(JSON.parse(fullCache.json)[0].id, "small");

const trimmedCache = serializeTaskCache(
  [{ id: "large", messages }],
  { maxBytes: 10, maxMessages: 7, maxTasks: 20 },
);
assert.equal(trimmedCache.lightweight, true);
assert.equal(JSON.parse(trimmedCache.json)[0].messages.length, 7);

const tasks = [
  {
    id: "task-1",
    messages: [
      { id: "user-1", role: "user", content: "hello" },
      { id: "assistant-1", role: "assistant", content: "", status: "running" },
    ],
  },
];
const withDelta = updateTaskMessageById(
  tasks,
  "task-1",
  "assistant-1",
  (message) => ({ ...message, content: `${message.content}stream` }),
);
assert.equal(withDelta[0].messages[1].content, "stream");
assert.equal(tasks[0].messages[1].content, "", "updates remain immutable");

const withFollowUp = appendTaskMessage(withDelta, "task-1", {
  id: "user-2",
  role: "user",
  content: "continue",
});
assert.equal(withFollowUp[0].messages.length, 3);

const store = createTaskStore(tasks);
let notifications = 0;
const unsubscribe = store.subscribe(() => {
  notifications += 1;
});
store.updateMessage(
  "task-1",
  "assistant-1",
  (message) => ({ ...message, content: "delta-1" }),
  { source: "harness.response.delta" },
);
assert.equal(store.getSnapshot()[0].messages[1].content, "delta-1");
assert.equal(store.revision, 1);
assert.equal(store.lastMutation.source, "harness.response.delta");
assert.equal(notifications, 1);

store.appendMessage("task-1", {
  id: "user-2",
  role: "user",
  content: "next",
});
assert.equal(store.revision, 2);
assert.equal(store.getSnapshot()[0].messages.length, 3);
assert.equal(notifications, 2);

store.update(() => store.getSnapshot(), { source: "noop" });
assert.equal(store.revision, 2, "identity updates do not publish a new revision");
assert.equal(notifications, 2);
unsubscribe();

console.log("task store smoke: PASS");

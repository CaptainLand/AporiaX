import assert from "node:assert/strict";
import {
  PURE_TASK_EVENT_TYPES,
  reduceHarnessTaskEvent,
} from "../src/state/harness-event-reducer.js";

const run = { taskId: "task-1", assistantId: "assistant-1" };
const base = [
  {
    id: "task-1",
    messages: [
      { id: "user-1", role: "user", content: "do it" },
      {
        id: "assistant-1",
        role: "assistant",
        content: "old",
        route: [],
      },
    ],
  },
];
const tr = (zh, en) => en;
const nowValues = [
  "2026-08-11T00:00:01.000Z",
  "2026-08-11T00:00:02.000Z",
  "2026-08-11T00:00:03.000Z",
  "2026-08-11T00:00:04.000Z",
];
const now = () => nowValues.shift() || "2026-08-11T00:00:05.000Z";

assert(PURE_TASK_EVENT_TYPES.has("tool.started"));
assert(PURE_TASK_EVENT_TYPES.has("witness.updated"));

let tasks = reduceHarnessTaskEvent(base, run, {
  type: "skill.activated",
  skills: [{ name: "web-review" }],
  unresolved: [],
}, { tr, now });
assert.equal(tasks[0].messages[1].activatedSkills[0].name, "web-review");

tasks = reduceHarnessTaskEvent(tasks, run, {
  type: "plan.updated",
  plan: { revision: 1, steps: [{ id: "a", title: "Inspect", status: "in_progress" }] },
}, { tr, now });
assert.equal(tasks[0].messages[1].plan.revision, 1);

tasks = reduceHarnessTaskEvent(tasks, run, {
  type: "response.reset",
}, { tr, now });
assert.equal(tasks[0].messages[1].content, "");

tasks = reduceHarnessTaskEvent(tasks, run, {
  type: "tool.started",
  runId: "run-1",
  callId: "call-1",
  tool: "mcp__github__create_issue",
  phase: "work",
  capability: {
    id: "mcp:run-1:tool",
    source: "mcp",
    risk: "control",
    stage: "forge",
    titleZh: "创建 Issue",
    titleEn: "Create issue",
    activityZh: "正在调用 MCP · 创建 Issue",
    activityEn: "Calling MCP · Create issue",
  },
}, { tr, language: "en", now });
let assistant = tasks[0].messages[1];
assert.equal(assistant.route.length, 1);
assert.equal(assistant.route[0].stage, "forge");
assert.equal(assistant.route[0].title, "Create issue");
assert.equal(assistant.route[0].capability.source, "mcp");

tasks = reduceHarnessTaskEvent(tasks, run, {
  type: "file.changed",
  path: "src/app.jsx",
  additions: 4,
  deletions: 1,
}, { tr, now });
assistant = tasks[0].messages[1];
assert.equal(assistant.route[0].path, "src/app.jsx");
assert.equal(assistant.route[0].additions, 4);

tasks = reduceHarnessTaskEvent(tasks, run, {
  type: "tool.completed",
  runId: "run-1",
  callId: "call-1",
  tool: "mcp__github__create_issue",
  success: true,
  detail: "created #42",
}, { tr, now });
assistant = tasks[0].messages[1];
assert.equal(assistant.route[0].status, "completed");
assert.equal(assistant.route[0].detail, "created #42");

const witness = { revision: 7, records: [] };
tasks = reduceHarnessTaskEvent(tasks, run, {
  type: "witness.updated",
  witness,
}, { tr, now });
assert.equal(tasks[0].messages[1].witness.revision, 7);

const unchanged = reduceHarnessTaskEvent(tasks, run, { type: "approval.required" }, { tr, now });
assert.strictEqual(unchanged, tasks);

console.log("Harness event reducer smoke: PASS");

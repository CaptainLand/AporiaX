import assert from "node:assert/strict";
import {
  closeRunningRouteEntries,
  collectLatestDeliverables,
  collectTaskDeliverables,
  collectTaskRouteEntries,
  collectTaskRouteRuns,
  enrichRouteEntries,
  getRouteToolMeta,
  summarizeRoutePrompt,
  updateRunAssistant,
} from "../src/p0-model.js";

const startedAt = "2026-07-30T00:00:00.000Z";
const finishedAt = "2026-07-30T00:00:01.250Z";
const liveRoute = [
  {
    id: "route",
    stage: "route",
    title: "理解任务并准备行动",
    status: "completed",
  },
  {
    id: "read",
    stage: "lens",
    title: "读取文件",
    tool: "read_file",
    status: "running",
    startedAt,
  },
  {
    id: "write",
    stage: "forge",
    title: "修改代码",
    tool: "apply_patch",
    status: "completed",
  },
];

const closed = closeRunningRouteEntries(liveRoute, finishedAt);
assert.equal(closed[1].status, "completed");
assert.equal(closed[1].finishedAt, finishedAt);

const selfCheck = {
  required: true,
  completed: true,
  verification: { required: true, passed: true },
};
const enriched = enrichRouteEntries(
  closed,
  [
    { name: "read_file", success: true, path: "src/main.jsx" },
    {
      name: "apply_patch",
      success: true,
      path: "src/main.jsx",
      additions: 8,
      deletions: 2,
    },
    {
      name: "run_command",
      success: true,
      command: "npm run build",
      exitCode: 0,
    },
    {
      name: "git_status",
      success: true,
      skipped: true,
      detail: "当前工作区不是 Git 仓库",
    },
    {
      name: "complete_self_check",
      success: false,
      retry: true,
      detail: "仍需重新读取修改文件",
    },
  ],
  { status: "completed", selfCheck },
);

assert.equal(enriched.filter((entry) => entry.stage === "deliver").length, 1);
assert.equal(
  enriched.filter((entry) => entry.kind === "self-check-complete").length,
  1,
);
assert.equal(
  enriched.find((entry) => entry.tool === "read_file").path,
  "src/main.jsx",
);
assert.equal(
  enriched.find((entry) => entry.tool === "run_command").stage,
  "trial",
);
assert.equal(
  enriched.find((entry) => entry.tool === "git_status").status,
  "skipped",
);
assert.equal(
  enriched.find((entry) => entry.tool === "complete_self_check").status,
  "retry",
);
assert.equal(getRouteToolMeta("read_file", "self-check").stage, "trial");

const updatedTasks = updateRunAssistant(
  [
    {
      id: "task-a",
      messages: [{ id: "assistant-a", role: "assistant", route: [] }],
    },
    {
      id: "task-b",
      messages: [{ id: "assistant-b", role: "assistant", route: [] }],
    },
  ],
  { taskId: "task-a", assistantId: "assistant-a" },
  (message) => ({ ...message, touched: true }),
);
assert.equal(updatedTasks[0].messages[0].touched, true);
assert.equal(updatedTasks[1].messages[0].touched, undefined);

const task = {
  messages: [
    {
      id: "assistant-1",
      role: "assistant",
      status: "completed",
      route: enriched,
      changes: [
        {
          path: "index.html",
          additions: 20,
          deletions: 0,
          created: true,
        },
        {
          path: "draft.md",
          additions: 5,
          deletions: 0,
          created: true,
        },
      ],
      selfCheck,
    },
    {
      id: "assistant-2",
      role: "assistant",
      status: "completed",
      changes: [
        {
          path: "index.html",
          additions: 4,
          deletions: 1,
        },
        {
          path: "draft.md",
          reverted: true,
        },
      ],
      selfCheck,
    },
    {
      id: "assistant-legacy",
      role: "assistant",
      status: "completed",
      steps: [{ name: "read_file", success: true, path: "index.html" }],
      changes: [],
      selfCheck: { required: false, completed: false },
    },
  ],
};

const deliverables = collectTaskDeliverables(task);
const latestDeliverables = collectLatestDeliverables(task);
assert.deepEqual(
  deliverables.map((file) => file.path),
  ["index.html"],
);
assert.equal(deliverables[0].additions, 4);
assert.equal(latestDeliverables.messageId, "assistant-2");
assert.equal(latestDeliverables.files.length, 1);
assert.equal(collectTaskRouteRuns(task).length, 3);
assert.equal(
  collectTaskRouteRuns(task).every((run) => run.entries.length > 0),
  true,
);
assert.equal(
  collectTaskRouteEntries(task).length,
  collectTaskRouteRuns(task).flatMap((run) => run.entries).length,
);

const roundTask = {
  messages: [
    {
      id: "user-round-1",
      role: "user",
      content: "创建品牌介绍页面",
    },
    {
      id: "assistant-round-1",
      sourceUserId: "user-round-1",
      role: "assistant",
      status: "completed",
      plan: {
        revision: 2,
        steps: [
          { id: "page", title: "创建页面", status: "completed" },
        ],
      },
      route: [{ id: "step-1", title: "创建页面", status: "completed" }],
      changes: [{ path: "index.html", additions: 20, deletions: 0 }],
    },
    {
      id: "user-round-2",
      role: "user",
      content: "把标题改成蓝色",
    },
    {
      id: "assistant-round-2",
      sourceUserId: "user-round-2",
      role: "assistant",
      status: "completed",
      route: [{ id: "step-2", title: "修改样式", status: "completed" }],
      changes: [{ path: "index.html", additions: 1, deletions: 1 }],
    },
  ],
};
const routeRuns = collectTaskRouteRuns(roundTask);
assert.equal(routeRuns.length, 2);
assert.equal(routeRuns[0].prompt, "创建品牌介绍页面");
assert.equal(routeRuns[1].prompt, "把标题改成蓝色");
assert.equal(routeRuns[0].summary, "创建品牌介绍页面");
assert.equal(routeRuns[0].plan.revision, 2);
assert.equal(routeRuns[0].plan.steps[0].id, "page");
assert.equal(
  summarizeRoutePrompt(
    "01：这是一个很长的任务提示词，需要处理多个文件并完成验证，同时保留完整的修改记录。",
  ),
  "这是一个很长的任务提示词，需要处理多个文件并完成验证，同时保留完…",
);
assert.equal(collectLatestDeliverables(roundTask).files[0].additions, 1);

const recoveredRun = collectTaskRouteRuns({
  messages: [
    {
      id: "assistant-recovered",
      role: "assistant",
      status: "completed",
      route: [
        {
          id: "word-invalid",
          tool: "create_word_document",
          title: "创建 Word 文档",
          status: "failed",
          detail: "Invalid arguments for create_word_document.",
        },
        {
          id: "word-success",
          tool: "create_word_document",
          title: "创建 Word 文档",
          status: "completed",
          path: "介绍.docx",
        },
      ],
    },
  ],
})[0];
assert.equal(recoveredRun.entries[0].status, "recovered");
assert.match(recoveredRun.entries[0].detail, /参数格式无效/);

console.log("P0 model smoke test passed.");

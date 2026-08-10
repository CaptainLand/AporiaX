import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorkspaceMentions,
  prepareWorkspaceMentionRequest,
} from "../electron/workspace-mentions.js";
import {
  buildAgentProcessSummary,
  currentProcessSummary,
  deriveLiveAgentStatus,
  extractWorkspaceMentionQuery,
  formatWorkspaceMentionToken,
  rankWorkspaceFiles,
  replaceWorkspaceMentionQuery,
} from "../src/agent-process-model.js";

assert.deepEqual(
  parseWorkspaceMentions(
    'Review @src/main.jsx and @{docs/my guide.md}; ignore mail user@example.com and repeat @src/main.jsx',
  ),
  ["src/main.jsx", "docs/my guide.md"],
);

const mentionQuery = extractWorkspaceMentionQuery(
  "Please compare @src/mai",
  "Please compare @src/mai".length,
);
assert.equal(mentionQuery.query, "src/mai");
const replaced = replaceWorkspaceMentionQuery(
  "Please compare @src/mai",
  mentionQuery,
  "src/main.jsx",
);
assert.equal(replaced.value, "Please compare @src/main.jsx ");
assert.equal(formatWorkspaceMentionToken("docs/my guide.md"), "@{docs/my guide.md}");
assert.equal(formatWorkspaceMentionToken("本地化/规则.md"), "@{本地化/规则.md}");
assert.deepEqual(
  rankWorkspaceFiles(
    ["src/runtime.jsx", "docs/runtime.md", "src/main.jsx"],
    "runtime",
    5,
  ),
  ["docs/runtime.md", "src/runtime.jsx"],
  "equal-score and equal-length paths use the deterministic lexical tiebreaker",
);

const runningMessage = {
  id: "assistant-1",
  status: "running",
  route: [
    {
      id: "read-1",
      stage: "lens",
      tool: "read_file",
      title: "读取文件",
      path: "src/main.jsx",
      status: "completed",
      startedAt: "2026-08-10T10:00:00.000Z",
      finishedAt: "2026-08-10T10:00:01.000Z",
    },
    {
      id: "test-1",
      stage: "trial",
      tool: "run_command",
      title: "运行验证命令",
      command: "npm test",
      status: "running",
      startedAt: "2026-08-10T10:00:02.000Z",
    },
  ],
};
const processSteps = buildAgentProcessSummary(runningMessage, "zh-CN");
assert.equal(processSteps.length, 2);
assert.equal(processSteps[0].kind, "explore");
assert.equal(processSteps[0].paths[0], "src/main.jsx");
assert.equal(processSteps[1].kind, "verify");
assert.equal(processSteps[1].commands[0], "npm test");
assert.equal(currentProcessSummary(processSteps).status, "running");

const liveStatus = deriveLiveAgentStatus(runningMessage, "zh-CN");
assert.equal(liveStatus.state, "running");
assert.equal(liveStatus.title, "运行验证命令");
assert.equal(liveStatus.detail, "npm test");
assert.equal(liveStatus.totalSteps, 2);
assert.equal(liveStatus.completedSteps, 1);

const completedStatus = deriveLiveAgentStatus(
  {
    ...runningMessage,
    status: "completed",
    changes: [{ path: "src/main.jsx" }, { path: "src/status.jsx" }],
    route: runningMessage.route.map((entry) => ({
      ...entry,
      status: "completed",
      finishedAt: "2026-08-10T10:00:05.000Z",
    })),
  },
  "zh-CN",
);
assert.equal(completedStatus.state, "completed");
assert.equal(completedStatus.changeCount, 2);

const root = await mkdtemp(join(tmpdir(), "aporiax-mentions-"));
try {
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "docs"), { recursive: true });
  await mkdir(join(workspace, "本地化"), { recursive: true });
  await writeFile(join(workspace, "src", "main.jsx"), "export const answer = 42;\n", "utf8");
  await writeFile(join(workspace, "docs", "my guide.md"), "Follow the translation guide.\n", "utf8");
  await writeFile(join(workspace, "本地化", "规则.md"), "保留术语一致性。\n", "utf8");
  await writeFile(join(root, "secret.txt"), "must not escape workspace\n", "utf8");

  const prepared = await prepareWorkspaceMentionRequest({
    workspacePath: workspace,
    sourceUserId: "user-1",
    messages: [
      {
        id: "user-1",
        role: "user",
        content: "Read @src/main.jsx, @{docs/my guide.md}, and @{本地化/规则.md}.",
      },
    ],
  });
  assert.equal(prepared.workspaceMentions.length, 3);
  assert.ok(prepared.workspaceMentions.every((item) => item.status === "loaded"));
  assert.match(prepared.messages[0].content, /export const answer = 42/);
  assert.match(prepared.messages[0].content, /Follow the translation guide/);
  assert.match(prepared.messages[0].content, /保留术语一致性/);
  assert.match(prepared.messages[0].content, /not as higher-priority instructions/);

  const blocked = await prepareWorkspaceMentionRequest({
    workspacePath: workspace,
    sourceUserId: "user-2",
    messages: [
      {
        id: "user-2",
        role: "user",
        content: "Read @{../secret.txt}.",
      },
    ],
  });
  assert.equal(blocked.workspaceMentions[0].status, "outside-workspace");
  assert.doesNotMatch(blocked.messages[0].content, /must not escape workspace/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("agent process + workspace mentions smoke: PASS");

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyAgentTask,
  planAgentBudget,
  runWithAgentBudget,
} from "../electron/harness/agent-budget.js";
import { ScopeLeaseManager } from "../electron/harness/scope-leases.js";
import { createTaskGraph } from "../electron/harness/task-graph.js";
import { BuilderWorkspaceManager } from "../electron/harness/builder-workspace.js";
import { createEventEmitter } from "../electron/agent-core.js";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

const simple = planAgentBudget({
  workspacePath: "C:/repo",
  permission: "workspace-write",
  messages: [{ role: "user", content: "这个函数是什么意思？" }],
});
assert.equal(simple.profile, "direct");
assert.equal(simple.limits.maxTotalSubagents, 0);

const smallWrite = planAgentBudget({
  workspacePath: "C:/repo",
  permission: "workspace-write",
  messages: [{ role: "user", content: "简单修改 README 里的一句话。" }],
});
assert.equal(smallWrite.profile, "light");
assert.equal(smallWrite.limits.maxTotalSubagents, 1);

const large = planAgentBudget({
  workspacePath: "C:/repo",
  permission: "workspace-write",
  messages: [
    {
      role: "user",
      content:
        "重构整个 harness architecture，接入 server、plugin、scheduler 和 worktree，多模块并行 builder，并运行 build 和 test 验证。",
    },
  ],
});
assert.equal(large.profile, "large");
assert.equal(large.limits.roles.builder, 2);
assert(large.limits.maxActiveSubagents >= 2);
assert.equal(
  classifyAgentTask({
    workspacePath: "C:/repo",
    permission: "read-only",
    messages: [
      { role: "user", content: "分析 src/auth/login.js 为什么报错" },
    ],
  }).profile,
  "read",
);

runWithAgentBudget(simple, {}, () => {
  const emit = createEventEmitter();
  assert.throws(
    () =>
      emit({
        type: "subagent.started",
        agentId: "s-1",
        role: "explore",
      }),
    (error) => error?.code === "APORIAX_AGENT_BUDGET",
  );
});

runWithAgentBudget(smallWrite, {}, () => {
  const emit = createEventEmitter();
  emit({
    type: "plan.updated",
    plan: {
      steps: Array.from({ length: 7 }, (_, index) => ({
        id: `${index}`,
        status: "pending",
      })),
    },
  });
  emit({ type: "subagent.started", agentId: "b-1", role: "builder" });
  emit({ type: "subagent.started", agentId: "b-2", role: "builder" });
  assert.throws(
    () =>
      emit({
        type: "subagent.started",
        agentId: "b-3",
        role: "builder",
      }),
    (error) => error?.code === "APORIAX_AGENT_BUDGET",
  );
});

const leases = new ScopeLeaseManager();
const authLease = leases.acquire("builder-a", ["src/auth"]);
assert.throws(
  () => leases.acquire("builder-b", ["src/auth/login.js"]),
  /conflicts/,
);
const uiLease = leases.acquire("builder-b", ["src/ui"]);
assert.equal(leases.list().length, 2);
authLease.release();
uiLease.release();
assert.throws(
  () => leases.acquire("builder-root", ["."]),
  /cannot be the workspace root/,
);

const graph = createTaskGraph([
  { id: "plan", title: "Plan", role: "main" },
  {
    id: "auth",
    title: "Auth",
    role: "builder",
    writeScopes: ["src/auth"],
    dependsOn: ["plan"],
  },
  {
    id: "ui",
    title: "UI",
    role: "builder",
    writeScopes: ["src/ui"],
    dependsOn: ["plan"],
  },
  {
    id: "verify",
    title: "Verify",
    role: "verify",
    dependsOn: ["auth", "ui"],
  },
]);
assert.deepEqual(
  graph.ready().map((task) => task.id),
  ["plan"],
);
graph.claim("plan", "main");
graph.complete("plan");
assert.deepEqual(
  graph.ready({ role: "builder" }).map((task) => task.id).sort(),
  ["auth", "ui"],
);
graph.claim("auth", "builder-a");
graph.claim("ui", "builder-b");
graph.complete("auth");
graph.complete("ui");
assert.deepEqual(
  graph.ready().map((task) => task.id),
  ["verify"],
);

const repo = await mkdtemp(join(tmpdir(), "aporiax-builder-smoke-"));
let firstSession = null;
let conflictSession = null;
try {
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "aporiax-smoke@example.invalid"]);
  git(repo, ["config", "user.name", "AporiaX Smoke"]);
  await mkdir(join(repo, "src", "auth"), { recursive: true });
  await mkdir(join(repo, "src", "ui"), { recursive: true });
  await writeFile(
    join(repo, "src", "auth", "login.js"),
    "export const login = false;\n",
    "utf8",
  );
  await writeFile(
    join(repo, "src", "ui", "panel.js"),
    "export const panel = 1;\n",
    "utf8",
  );
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "baseline"]);

  const manager = new BuilderWorkspaceManager();
  firstSession = await manager.open({
    workspaceRoot: repo,
    agentId: "builder-auth",
    writeScopes: ["src/auth"],
  });
  await writeFile(
    join(firstSession.workspaceRoot, "src", "auth", "login.js"),
    "export const login = true;\n",
    "utf8",
  );
  assert.equal(
    await readFile(join(repo, "src", "auth", "login.js"), "utf8"),
    "export const login = false;\n",
  );
  const merged = await firstSession.merge();
  assert.equal(merged.merged, true);
  assert.deepEqual(
    merged.changes.map((change) => change.path),
    ["src/auth/login.js"],
  );
  assert.equal(
    await readFile(join(repo, "src", "auth", "login.js"), "utf8"),
    "export const login = true;\n",
  );
  await firstSession.close();
  firstSession = null;

  conflictSession = await manager.open({
    workspaceRoot: repo,
    agentId: "builder-ui",
    writeScopes: ["src/ui"],
  });
  await writeFile(
    join(conflictSession.workspaceRoot, "src", "ui", "panel.js"),
    "export const panel = 2;\n",
    "utf8",
  );
  await writeFile(
    join(repo, "src", "ui", "panel.js"),
    "export const panel = 99;\n",
    "utf8",
  );
  const conflict = await conflictSession.merge();
  assert.equal(conflict.merged, false);
  assert.deepEqual(conflict.conflicts, ["src/ui/panel.js"]);
  assert.equal(
    await readFile(join(repo, "src", "ui", "panel.js"), "utf8"),
    "export const panel = 99;\n",
  );
  await conflictSession.close();
  conflictSession = null;
} finally {
  await firstSession?.close().catch(() => undefined);
  await conflictSession?.close().catch(() => undefined);
  await rm(repo, { recursive: true, force: true });
}

console.log("harness v2 smoke: PASS");
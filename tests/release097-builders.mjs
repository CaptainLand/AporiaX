import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planAgentBudget, runWithAgentBudget, withAgentBudgetAdmission, enforceAgentBudgetEvent, currentAgentBudget } from "../electron/harness/agent-budget.js";
import { normalizeBuilderCount, MAX_BUILDERS } from "../electron/harness/builder-count.js";
import { createBuilderWorkspaceManager, builderSnapshotLimits } from "../electron/harness/builder-workspace.js";
import { runIsolatedBuilder } from "../electron/runtime/delegated-builder.js";
import { runWorkbenchGit } from "../electron/workbench/git-service.js";
import { revertWorkspaceChanges } from "../electron/agent-runtime-core.js";

assert.equal(MAX_BUILDERS, 6); assert.equal(normalizeBuilderCount(1), 1); assert.equal(normalizeBuilderCount(null, 2), 2);
const options = { workspacePath: "fixture", permission: "workspace-write", prompt: "实现修改", builderLimit: 2 };
const events = []; let peak = 0, running = 0;
await runWithAgentBudget(planAgentBudget(options), { onEvent: (event) => events.push(event) }, async () => {
  await Promise.all(Array.from({ length: 9 }, (_, index) => withAgentBudgetAdmission({ role: "builder" }, async () => {
    const id = "builder-" + index;
    enforceAgentBudgetEvent({ type: "subagent.started", role: "builder", agentId: id }); peak = Math.max(peak, ++running);
    await new Promise((resolve) => setTimeout(resolve, 5)); running--;
    enforceAgentBudgetEvent({ type: "subagent.completed", role: "builder", agentId: id });
  })));
  assert.equal(currentAgentBudget().state.totalStarted, 9); assert.equal(currentAgentBudget().state.queuedBuilders, 0);
});
assert.equal(peak, 2); assert.ok(events.some((event) => event.queuedBuilders > 0));
for (const cap of [1, 6]) {
  let active = 0, maximum = 0;
  await runWithAgentBudget(planAgentBudget({ ...options, builderLimit: cap }), {}, async () => {
    await Promise.all(Array.from({ length: 9 }, (_, index) => withAgentBudgetAdmission({ role: "builder" }, async () => {
      const agentId = `cap-${cap}-${index}`;
      enforceAgentBudgetEvent({ type: "subagent.started", role: "builder", agentId }); maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5)); active--;
      enforceAgentBudgetEvent({ type: "subagent.completed", role: "builder", agentId });
    })));
  });
  assert.equal(maximum, cap);
}
await runWithAgentBudget(planAgentBudget({ ...options, agentBudget: { maxTotalSubagents: 1 } }), {}, async () => {
  enforceAgentBudgetEvent({ type: "subagent.started", role: "builder", agentId: "a" });
  enforceAgentBudgetEvent({ type: "subagent.completed", role: "builder", agentId: "a" });
  assert.throws(() => enforceAgentBudgetEvent({ type: "subagent.started", role: "builder", agentId: "b" }), /budget/);
});
await runWithAgentBudget(planAgentBudget({ ...options, builderLimit: 0 }), {}, async () => {
  await assert.rejects(withAgentBudgetAdmission({ role: "builder" }, () => {}), /prohibits/);
});
const root = await mkdtemp(join(tmpdir(), "aporiax-097-builder-"));
const git = async (...args) => { const value = await runWorkbenchGit(root, args); assert.equal(value.code, 0, value.stderr); };
await git("init", "-b", "main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid"); await git("config", "commit.gpgsign", "false"); await git("config", "core.hooksPath", join(root, "no-hooks"));
const original = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), changed = Buffer.concat([original, Buffer.from(" changed")]);
await writeFile(join(root, "gbk.txt"), original);
await writeFile(join(root, "outside.txt"), Buffer.alloc(9_000_000, 65));
await git("add", "--", "gbk.txt", "outside.txt"); await git("commit", "-m", "base");
// An unrelated 9 MiB dirty file must not be charged to a tiny Builder scope.
await writeFile(join(root, "outside.txt"), Buffer.alloc(9_000_000, 66));
const session = {}, builderOptions = { agentId: "encoding", input: { writeScopes: ["gbk.txt"] }, session, workspaceRoot: root, emit() {} };
await runIsolatedBuilder(builderOptions, async ({ workspaceRoot }) => { await writeFile(join(workspaceRoot, "gbk.txt"), changed); return { status: "interrupted" }; });
assert.equal(session.provisionalChanges[0].afterBase64, changed.toString("base64"));
let checkpoints;
const result = await runIsolatedBuilder({ ...builderOptions, onBuilderMerge: async (merged) => { checkpoints = merged.checkpoints; } }, async ({ workspaceRoot }) => { assert.deepEqual(await readFile(join(workspaceRoot, "gbk.txt")), changed); return { status: "completed" }; });
assert.equal(result.integrated, true); assert.deepEqual(await readFile(join(root, "gbk.txt")), changed);
assert.equal((await revertWorkspaceChanges({ workspacePath: root, changes: checkpoints }))[0].success, true);
assert.deepEqual(await readFile(join(root, "gbk.txt")), original);
assert.equal(session.snapshotLimits.maxFiles, 3000);
assert.throws(() => builderSnapshotLimits({ maxBytes: -1 }), /Invalid/);
assert.throws(() => builderSnapshotLimits({ maxFileBytes: 10, maxBytes: 5 }), /maxFileBytes/);
const manager = createBuilderWorkspaceManager({ snapshotLimits: { maxFileBytes: 1 } });
await assert.rejects(manager.open({ workspaceRoot: root, agentId: "preflight", writeScopes: ["gbk.txt"] }), /exceeds/);
assert.equal(manager.leases().length, 0);
console.log("PASS 0.9.7 Builder: 9 workers in waves, cap 2, explicit budgets, disabled mode, GBK resume, unrelated large file, preflight");

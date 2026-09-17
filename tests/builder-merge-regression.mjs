import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, basename, dirname, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createBuilderWorkspaceManager } from "../electron/harness/builder-workspace.js";
import { runIsolatedBuilder } from "../electron/runtime/delegated-builder.js";
import { withDurableRun } from "../electron/runtime/durable-run.js";
import { sharedScopeLeases } from "../electron/harness/shared-scope-leases.js";

const run = promisify(execFile);
const originals = { open: fs.open, rename: fs.rename, rm: fs.rm };
const scenarios = ["success", "partial-stage", "replace-failure", "rollback-failure", "journal-failure", "commit-journal-rollback-failure", "user-edit", "deletion-rollback", "preparation-failure"];
for (const scenario of scenarios) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "aporiax-builder-atomic-")));
  let workspace;
  let recovery;
  const events = [];
  try {
    const git = (...args) => run("git", args, { cwd: root, windowsHide: true });
    await git("init", "-q");
    await fs.writeFile(join(root, "a.txt"), "original-a\n");
    await fs.writeFile(join(root, "b.txt"), "original-b\n");
    await git("add", "a.txt", "b.txt");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    let prepared = false;
    workspace = await createBuilderWorkspaceManager({ eventBus: { emit: e => events.push(e) },
      onMergePrepared: async (value) => {
        recovery = value;
        const manifest = JSON.parse(await fs.readFile(value.manifestPath, "utf8"));
        assert.equal(manifest.status, "prepared");
        assert.equal(await fs.readFile(join(root, "a.txt"), "utf8"), "original-a\n");
        assert.equal(await fs.readFile(join(dirname(value.manifestPath), "0.before"), "utf8"), "original-a\n");
        prepared = true;
        if (scenario === "preparation-failure") throw new Error("injected checkpoint failure");
      },
    }).open({ workspaceRoot: root, agentId: scenario, writeScopes: ["a.txt", "b.txt", "new.txt"] });
    if (scenario === "deletion-rollback") await fs.rm(join(workspace.workspaceRoot, "a.txt"));
    else await fs.writeFile(join(workspace.workspaceRoot, "a.txt"), "updated-a\n");
    await fs.writeFile(join(workspace.workspaceRoot, "b.txt"), "updated-b\n");
    await fs.writeFile(join(workspace.workspaceRoot, "new.txt"), "new-file\n");
    let triggered = false;
    fs.open = async (path, ...args) => {
      const handle = await originals.open(path, ...args);
      if (scenario === "partial-stage" && dirname(String(path)) === root && basename(String(path)).startsWith(".b.txt.aporiax-")) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async () => { triggered = true; await write("part"); throw Object.assign(new Error("injected partial stage"), { code: "ENOSPC" }); };
      }
      return handle;
    };
    fs.rename = async (source, target) => {
      const to = resolve(String(target));
      if (["replace-failure", "rollback-failure", "user-edit", "deletion-rollback"].includes(scenario) && to === resolve(root, "b.txt")) {
        triggered = true;
        if (scenario === "user-edit") await fs.writeFile(join(root, "a.txt"), "newer user edit\n");
        throw Object.assign(new Error("injected replacement failure"), { code: "EBUSY" });
      }
      if (["rollback-failure", "commit-journal-rollback-failure"].includes(scenario) && triggered && to === resolve(root, "a.txt")) throw new Error("injected rollback failure");
      if (["journal-failure", "commit-journal-rollback-failure"].includes(scenario) && prepared && !triggered && basename(to) === "manifest.json") {
        const proposed = JSON.parse(await fs.readFile(source, "utf8"));
        if (scenario === "journal-failure" ? proposed.entries[0].state === "applied" : proposed.status === "committed") {
          triggered = true; throw new Error("injected journal failure");
        }
      }
      return originals.rename(source, target);
    };
    let failure;
    let result;
    try { result = await workspace.merge(); } catch (error) { failure = error; }
    fs.open = originals.open; fs.rename = originals.rename;
    const a = await fs.readFile(join(root, "a.txt"), "utf8");
    const b = await fs.readFile(join(root, "b.txt"), "utf8");
    if (scenario === "success") {
      assert.equal(result.merged, true); assert.equal(a, "updated-a\n"); assert.equal(b, "updated-b\n");
      assert.equal(await fs.readFile(join(root, "new.txt"), "utf8"), "new-file\n");
      assert.deepEqual(result.recovery.unresolved, []);
    } else {
      assert.equal(failure?.code, "BUILDER_MERGE_FAILED");
      assert.equal(b, "original-b\n");
      assert.equal(a, ["rollback-failure", "commit-journal-rollback-failure"].includes(scenario) ? "updated-a\n" : scenario === "user-edit" ? "newer user edit\n" : "original-a\n");
      assert.equal(await fs.lstat(join(root, "new.txt")).then(() => true, () => false), false);
      assert(events.some(e => e.type === "builder.merge.failed"));
      const manifest = JSON.parse(await fs.readFile(failure.mergeRecovery.manifestPath, "utf8"));
      assert.equal(manifest.entries.find(e => e.path === "a.txt").beforeHash.length, 64);
      if (["rollback-failure", "commit-journal-rollback-failure", "user-edit"].includes(scenario)) {
        assert.deepEqual(failure.mergeRecovery.unresolved, ["a.txt"]);
        assert.match(failure.message, /未恢复文件：a.txt/);
        await assert.rejects(() => workspace.close(), /retained/);
        await assert.rejects(() => workspace.merge(), /previous Builder merge/);
        assert.equal(manifest.status, "recovery-required");
      } else assert.deepEqual(failure.mergeRecovery.unresolved, []);
      if (scenario !== "preparation-failure") assert(triggered);
    }
    assert(!(await fs.readdir(root)).some(name => name.includes(".aporiax-") && name.endsWith(".tmp")), "stage files cleaned");
    console.log(`Builder merge: ${scenario}: PASS`);
  } finally {
    fs.open = originals.open; fs.rename = originals.rename; fs.rm = originals.rm;
    if (workspace) await workspace.close({ discardRecovery: true }); // owned fixtures only
    await fs.rm(root, { recursive: true, force: true });
  }
}
console.log(`Builder merge regression: ${scenarios.length}/${scenarios.length} PASS.`);

// Exercise the production delegate wrapper as well as the low-level merger:
// the recovery location must reach the task store and the worktree must survive.
{
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "aporiax-builder-wrapper-")));
  const session = {};
  const states = [];
  const agentId = "retained-fixture";
  const git = (...args) => run("git", args, { cwd: root, windowsHide: true });
  try {
    await git("init", "-q");
    await fs.writeFile(join(root, "a.txt"), "original-a\n");
    await fs.writeFile(join(root, "b.txt"), "original-b\n");
    await git("add", "a.txt", "b.txt");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    let second = false;
    fs.rename = async (source, target) => {
      if (resolve(String(target)) === resolve(root, "b.txt")) { second = true; throw new Error("fixture replacement failed"); }
      if (second && resolve(String(target)) === resolve(root, "a.txt")) throw new Error("fixture rollback failed");
      return originals.rename(source, target);
    };
    await assert.rejects(() => withDurableRun({ operation: async () => {},
      context: async (_id, json) => {
        const value = JSON.parse(json);
        if (value.session?.mergeRecovery?.status === "prepared") assert.equal(await fs.readFile(join(root, "a.txt"), "utf8"), "original-a\n");
        states.push(value);
      },
    }, () => runIsolatedBuilder({ agentId, workspaceRoot: root, session, emit() {},
      input: { role: "builder", task: "fixture", writeScopes: ["a.txt", "b.txt"] },
    }, async ({ workspaceRoot }) => {
      await fs.writeFile(join(workspaceRoot, "a.txt"), "updated-a\n");
      await fs.writeFile(join(workspaceRoot, "b.txt"), "updated-b\n");
      return { status: "completed", summary: "fixture" };
    })), error => error.code === "BUILDER_MERGE_FAILED");
    fs.rename = originals.rename;
    assert(states.some(state => state.session?.mergeRecovery?.status === "prepared"));
    assert.equal(states.at(-1).status, "merge-failed");
    assert.deepEqual(states.at(-1).session.mergeRecovery.unresolved, ["a.txt"]);
    assert.equal(session.provisionalChanges.length, 2);
    assert((await fs.stat(session.activeWorktree)).isDirectory());
    assert((await fs.stat(session.mergeRecovery.manifestPath)).isFile());
    console.log("Builder delegate: recovery persisted, provisional changes and worktree retained: PASS");
  } finally {
    fs.rename = originals.rename;
    if (session.activeWorktree) {
      const base = dirname(session.activeWorktree);
      const inside = relative(await fs.realpath(tmpdir()), await fs.realpath(base));
      assert(inside && inside.startsWith("aporiax-builder-") && !inside.startsWith("..") && !isAbsolute(inside));
      await git("worktree", "remove", "--force", session.activeWorktree);
      await fs.rm(base, { recursive: true, force: true });
    }
    sharedScopeLeases.release(agentId, { workspaceRoot: await fs.realpath(root) });
    await fs.rm(root, { recursive: true, force: true });
  }
}

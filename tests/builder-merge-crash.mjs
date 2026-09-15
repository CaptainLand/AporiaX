import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createBuilderWorkspaceManager } from "../electron/harness/builder-workspace.js";

if (process.argv[2] === "--fixture-child") {
  const root = process.argv[3];
  let worktreeRoot;
  const workspace = await createBuilderWorkspaceManager({ onMergePrepared: async recovery => {
    // Fixture-only rendezvous. Production uses the task store before mutation.
    await fs.writeFile(join(root, "fixture-recovery.json"), JSON.stringify({ ...recovery, worktreeRoot }));
  } }).open({ workspaceRoot: root, agentId: "crash", writeScopes: ["a.txt", "b.txt"] });
  worktreeRoot = workspace.workspaceRoot;
  await fs.writeFile(join(worktreeRoot, "a.txt"), "updated-a\n");
  await fs.writeFile(join(worktreeRoot, "b.txt"), "updated-b\n");
  const originalRename = fs.rename;
  fs.rename = async (source, target) => {
    await originalRename(source, target);
    if (resolve(String(target)) === resolve(root, "a.txt")) process.exit(73);
  };
  await workspace.merge();
  throw new Error("Fixture should have exited between replacement and journal completion.");
} else {
  const run = promisify(execFile);
  const root = await fs.mkdtemp(join(tmpdir(), "aporiax-builder-crash-"));
  let recovery;
  try {
    const git = (...args) => run("git", args, { cwd: root, windowsHide: true });
    await git("init", "-q");
    await fs.writeFile(join(root, "a.txt"), "original-a\n");
    await fs.writeFile(join(root, "b.txt"), "original-b\n");
    await git("add", "a.txt", "b.txt");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    await assert.rejects(() => run(process.execPath, [fileURLToPath(import.meta.url), "--fixture-child", root],
      { windowsHide: true, timeout: 15000 }), error => error.code === 73);
    recovery = JSON.parse(await fs.readFile(join(root, "fixture-recovery.json"), "utf8"));
    const manifest = JSON.parse(await fs.readFile(recovery.manifestPath, "utf8"));
    assert.equal(manifest.status, "applying");
    assert.equal(manifest.entries[0].state, "attempted");
    assert.equal(await fs.readFile(join(root, "a.txt"), "utf8"), "updated-a\n");
    assert.equal(await fs.readFile(join(root, "b.txt"), "utf8"), "original-b\n");
    assert.equal(await fs.readFile(join(dirname(recovery.manifestPath), manifest.entries[0].backup), "utf8"), "original-a\n");
    assert.equal(await fs.readFile(join(recovery.worktreeRoot, "b.txt"), "utf8"), "updated-b\n");
    console.log("Builder crash: flushed intent, original backup and worktree survive process exit: PASS");
  } finally {
    if (recovery?.worktreeRoot) {
      // Exact test-created worktree, checked before recursive cleanup.
      const base = dirname(recovery.worktreeRoot);
      const inside = relative(resolve(tmpdir()), resolve(base));
      assert(inside && !inside.startsWith("..") && !isAbsolute(inside));
      assert(inside.startsWith("aporiax-builder-"));
      await run("git", ["worktree", "remove", "--force", recovery.worktreeRoot], { cwd: root, windowsHide: true });
      await fs.rm(base, { recursive: true, force: true });
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyPatch, parsePatch } from "diff";
import { prepareControlWorkspace, finalizeControlWorkspace } from "../electron/control/workspaces.js";
import { sanitizeRunResult } from "../electron/run-store.js";

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "aporiax-control-workspaces-"));
const git = (cwd, ...args) => run("git", ["-c", "user.name=Control test", "-c", "user.email=control-test@example.invalid", ...args], { cwd, windowsHide: true });
const contents = path => readFile(path, "utf8");
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
let checks = 0;

try {
  const source = join(root, "git-source"), data = join(root, "app-data");
  await mkdir(source);
  await git(source, "init", "--quiet");
  await writeFile(join(source, "tracked.txt"), "committed version\n");
  await writeFile(join(source, "deleted.txt"), "committed deletion fixture\n");
  await writeFile(join(source, "staged.txt"), "staged base\n");
  await writeFile(join(source, "script.sh"), "#!/bin/sh\necho fixture\n");
  await chmod(join(source, "script.sh"), 0o755);
  await git(source, "add", ".");
  await git(source, "commit", "--quiet", "-m", "fixture");
  await writeFile(join(source, "tracked.txt"), "dirty starting version\n");
  await rm(join(source, "deleted.txt"));
  await writeFile(join(source, "untracked.txt"), "untracked starting version\n");
  await writeFile(join(source, "staged.txt"), "staged starting version\n");
  await git(source, "add", "staged.txt");
  await mkdir(join(source, "node_modules"));
  await writeFile(join(source, "node_modules", "excluded.txt"), "do not copy dependencies");
  const beforeStatus = (await git(source, "status", "--porcelain=v1")).stdout;
  const beforeIndex = await readFile(join(source, ".git", "index"));
  const handle = await prepareControlWorkspace({ sourcePath: source, dataDirectory: data, runId: "git-dirty", writable: true });
  assert.equal(handle.workspace.mode, "worktree");
  assert.notEqual(handle.workspacePath, await realpath(source));
  assert.equal(await contents(join(handle.workspacePath, "tracked.txt")), "dirty starting version\n");
  assert.equal(await contents(join(handle.workspacePath, "untracked.txt")), "untracked starting version\n");
  assert.equal(await contents(join(handle.workspacePath, "staged.txt")), "staged starting version\n");
  assert.equal(await exists(join(handle.workspacePath, "deleted.txt")), false);
  assert.equal(await exists(join(handle.workspacePath, "node_modules")), false);
  assert.deepEqual(await readFile(join(source, ".git", "index")), beforeIndex, "source index is unchanged");
  assert.equal((await git(source, "status", "--porcelain=v1")).stdout, beforeStatus);
  if (process.platform !== "win32") assert((await lstat(join(handle.workspacePath, "script.sh"))).mode & 0o100);
  checks += 1;

  await writeFile(join(handle.workspacePath, "tracked.txt"), "agent changed version\n");
  await rm(join(handle.workspacePath, "untracked.txt"));
  await writeFile(join(handle.workspacePath, "new.txt"), "new output\n");
  const finalized = await finalizeControlWorkspace(handle, { status: "completed", content: "done" });
  assert.deepEqual(finalized.workspaceChanges.map(({ path, status }) => ({ path, status })), [
    { path: "new.txt", status: "added" }, { path: "tracked.txt", status: "modified" }, { path: "untracked.txt", status: "deleted" },
  ]);
  const patch = await contents(join(handle.workspacePath, ".aporiax-control-output", "changes.patch"));
  assert(patch.includes("-dirty starting version"));
  assert(!patch.includes("committed version"));
  assert(!patch.includes("deleted.txt"), "the already-deleted source file is not a new deletion");
  const trackedPatch = parsePatch(patch).find(item => item.oldFileName === "a/tracked.txt");
  assert.equal(applyPatch("dirty starting version\n", trackedPatch), "agent changed version\n");
  const manifest = JSON.parse(await contents(join(handle.workspacePath, ".aporiax-control-output", "manifest.json")));
  assert.equal(manifest.patchComplete, true);
  assert.equal(manifest.changes.length, 3);
  assert(finalized.artifacts.some(item => item.path === ".aporiax-control-output/changes.patch"));
  assert.equal(await contents(join(source, "tracked.txt")), "dirty starting version\n");
  assert.equal(await contents(join(source, "untracked.txt")), "untracked starting version\n");
  assert.equal(await exists(join(source, "new.txt")), false);
  assert.equal((await git(source, "status", "--porcelain=v1")).stdout, beforeStatus);
  checks += 1;

  const noData = join(root, "read-only-no-data");
  const readOnly = await prepareControlWorkspace({ sourcePath: source, dataDirectory: noData, runId: "read-only", writable: false });
  assert.equal(readOnly.workspacePath, await realpath(source));
  assert.equal(readOnly.workspace.mode, "read-only");
  assert.equal(readOnly.baselineRoot, undefined);
  assert.equal(await exists(noData), false);
  assert.deepEqual(await finalizeControlWorkspace(readOnly, { status: "completed" }), { status: "completed", workspace: readOnly.workspace });
  checks += 1;

  const plain = join(root, "plain-source");
  await mkdir(join(plain, "nested"), { recursive: true });
  await writeFile(join(plain, "file.txt"), "plain original\n");
  await writeFile(join(plain, "nested", "inner.txt"), "nested original\n");
  const plainHandle = await prepareControlWorkspace({ sourcePath: plain, dataDirectory: data, runId: "plain", writable: true });
  assert.equal(plainHandle.workspace.mode, "snapshot");
  assert.equal(await exists(join(plainHandle.workspacePath, ".git")), false);
  await writeFile(join(plainHandle.workspacePath, "file.txt"), "plain changed\n");
  assert.equal(await contents(join(plain, "file.txt")), "plain original\n");
  await finalizeControlWorkspace(plainHandle, { status: "completed" });
  assert((await contents(join(plainHandle.workspacePath, ".aporiax-control-output", "changes.patch"))).includes("-plain original"));
  checks += 1;

  await assert.rejects(prepareControlWorkspace({ sourcePath: plain, dataDirectory: data, runId: "plain", writable: true }), { code: "EEXIST" });
  assert.equal(await contents(join(plainHandle.workspacePath, "file.txt")), "plain changed\n");
  await assert.rejects(prepareControlWorkspace({ sourcePath: plain, dataDirectory: join(plain, "should-not-be-created"), runId: "nested-data", writable: true }), /CONTROL_WORKSPACE_ROOT/);
  assert.equal(await exists(join(plain, "should-not-be-created")), false);
  checks += 1;

  const stop = new AbortController(); stop.abort();
  await assert.rejects(prepareControlWorkspace({ sourcePath: plain, dataDirectory: data, runId: "pre-cancelled", writable: true, signal: stop.signal }), { name: "AbortError" });
  assert.equal(await exists(join(data, "local-control-workspaces", "pre-cancelled")), false);
  const bulk = join(root, "bulk-source"); await mkdir(bulk);
  await Promise.all(Array.from({ length: 150 }, (_, index) => writeFile(join(bulk, `${index}.txt`), "snapshot\n".repeat(200))));
  const midStop = new AbortController();
  const preparation = prepareControlWorkspace({ sourcePath: bulk, dataDirectory: data, runId: "mid-cancelled", writable: true, signal: midStop.signal });
  const timer = setTimeout(() => midStop.abort(), 5);
  try { await assert.rejects(preparation, { name: "AbortError" }); } finally { clearTimeout(timer); }
  assert.equal(await exists(join(data, "local-control-workspaces", "mid-cancelled")), false);
  assert.equal((await readdir(bulk)).length, 150);
  checks += 1;

  let linksSupported = true;
  try { await symlink(join(plain, "file.txt"), join(plain, "file-alias.txt"), "file"); }
  catch (error) { if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error; linksSupported = false; }
  if (linksSupported) {
    await symlink(join(plain, "nested"), join(plain, "nested-alias"), process.platform === "win32" ? "junction" : "dir");
    const linked = await prepareControlWorkspace({ sourcePath: plain, dataDirectory: data, runId: "internal-links", writable: true });
    assert.equal((await lstat(join(linked.workspacePath, "file-alias.txt"))).isSymbolicLink(), false);
    assert.equal((await lstat(join(linked.workspacePath, "nested-alias"))).isSymbolicLink(), false);
    assert.equal(await contents(join(linked.workspacePath, "file-alias.txt")), "plain original\n");
    assert.equal(await contents(join(linked.workspacePath, "nested-alias", "inner.txt")), "nested original\n");
    await writeFile(join(linked.workspacePath, "file-alias.txt"), "isolated alias\n");
    assert.equal(await contents(join(plain, "file.txt")), "plain original\n");
    assert.equal(await contents(join(linked.workspacePath, "file.txt")), "plain original\n");
    checks += 1;

    const outside = join(root, "outside-secret.txt"); await writeFile(outside, "outside original\n");
    await symlink(outside, join(plain, "outside-link.txt"), "file");
    await assert.rejects(prepareControlWorkspace({ sourcePath: plain, dataDirectory: data, runId: "outside-link", writable: true }), /CONTROL_WORKSPACE_LINK/);
    assert.equal(await exists(join(data, "local-control-workspaces", "outside-link")), false);
    assert.equal(await contents(outside), "outside original\n");
    await rm(join(plain, "outside-link.txt"));
    await symlink(plain, join(plain, "cycle"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(prepareControlWorkspace({ sourcePath: plain, dataDirectory: data, runId: "cycle", writable: true }), /CONTROL_WORKSPACE_LINK/);
    await rm(join(plain, "cycle"));
    checks += 1;

    const collisionDir = join(data, "local-control-workspaces", "collision");
    await mkdir(join(collisionDir, "workspace"), { recursive: true });
    await symlink(outside, join(collisionDir, "workspace", "file.txt"), "file");
    await assert.rejects(prepareControlWorkspace({ sourcePath: plain, dataDirectory: data, runId: "collision", writable: true }), { code: "EEXIST" });
    assert.equal(await contents(outside), "outside original\n");
    assert.equal((await lstat(join(collisionDir, "workspace", "file.txt"))).isSymbolicLink(), true);
    const aliasData = join(root, "data-alias");
    await symlink(plain, aliasData, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(prepareControlWorkspace({ sourcePath: plain, dataDirectory: join(aliasData, "new-app-data"), runId: "alias-data", writable: true }), /CONTROL_WORKSPACE_ROOT/);
    assert.equal(await exists(join(plain, "new-app-data")), false);
    checks += 1;

    const output = join(linked.workspacePath, ".aporiax-control-output");
    await mkdir(output);
    await symlink(outside, join(output, "changes.patch"), "file");
    await symlink(outside, join(output, "manifest.json"), "file");
    const outputResult = await finalizeControlWorkspace(linked, { status: "completed" });
    assert.equal(await contents(outside), "outside original\n");
    assert.equal((await lstat(join(output, "changes.patch"))).isSymbolicLink(), false);
    assert(outputResult.artifacts.some(item => item.path.endsWith("changes.patch")));
    await rm(output, { recursive: true });
    await symlink(join(plain, "nested"), output, process.platform === "win32" ? "junction" : "dir");
    const refusedOutput = await finalizeControlWorkspace(linked, { status: "completed" });
    assert(refusedOutput.risks.some(risk => risk.includes("Output manifest directory was replaced")));
    assert.equal(await exists(join(plain, "nested", "changes.patch")), false);
    checks += 1;
  } else console.log("Workspace symlink tests skipped: Windows account lacks symlink privileges.");

  await writeFile(join(plainHandle.workspacePath, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  const binaryResult = await finalizeControlWorkspace(plainHandle, { status: "completed", risks: ["existing risk"] });
  assert.equal(binaryResult.workspaceChanges.find(change => change.path === "binary.bin").patchOmitted, true);
  assert(binaryResult.risks.some(risk => risk.includes("binary/large")));
  const publicResult = sanitizeRunResult({ ...binaryResult, steps: Array.from({ length: 12_000 }, () => ({ detail: "large step".repeat(100) })) });
  assert.deepEqual(JSON.parse(JSON.stringify(publicResult.workspace)), binaryResult.workspace);
  assert.deepEqual(JSON.parse(JSON.stringify(publicResult.workspaceChanges)), binaryResult.workspaceChanges);
  assert.deepEqual(publicResult.risks, binaryResult.risks);
  assert.equal(publicResult.resultStorage.truncated, true);
  checks += 1;

  await writeFile(join(plain, "costly.txt"), Array.from({ length: 15_000 }, (_, index) => `before-${index}\n`).join(""));
  const costly = await prepareControlWorkspace({ sourcePath: plain, dataDirectory: data, runId: "costly-diff", writable: true });
  await writeFile(join(costly.workspacePath, "costly.txt"), Array.from({ length: 15_000 }, (_, index) => `after-${index}\n`).join(""));
  const boundedDiff = await finalizeControlWorkspace(costly, { status: "completed" });
  assert.equal(boundedDiff.workspaceChanges.find(change => change.path === "costly.txt").patchOmittedReason, "diff_limit");
  assert(boundedDiff.artifacts.some(item => item.path === "costly.txt"), "the full file remains available when diff computation is bounded");
  checks += 1;

  console.log(`Local control workspaces: PASS (${checks} groups: dirty Git, original isolation, snapshot-relative patches, read-only, non-Git, cancellation, links, retained collisions, safe outputs, durable workspace metadata)`);
} finally {
  await rm(root, { recursive: true, force: true });
}

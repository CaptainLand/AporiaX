import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { withUnderstandingWriteLock } from "../electron/understanding-write-lock.js";
import { createProjectUnderstandingStore } from "../electron/project-understanding.js";

if (process.argv[2] === "hold-lock") {
  await withUnderstandingWriteLock(process.argv[3], async () => {
    process.send("locked");
    await new Promise(() => { setInterval(() => {}, 1000); });
  });
} else {
  const root = await mkdtemp(join(tmpdir(), "aporia-understanding-lock-"));
  let child;
  try {
    const file = join(root, "fixture.json");
    await writeFile(file, "original");
    child = fork(import.meta.filename, ["hold-lock", file], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const ready = await Promise.race([once(child, "message").then(([message]) => message),
      once(child, "exit").then(([code]) => { throw new Error(`Fixture exited before lock: ${code}`); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Lock fixture timed out")), 10000); timer.unref(); })]);
    assert.equal(ready, "locked");
    await assert.rejects(withUnderstandingWriteLock(file, () => writeFile(file, "unsafe"), { timeoutMs: 80 }), /store is busy/);
    assert.equal(await readFile(file, "utf8"), "original", "active writer is never evicted");
    const exited = once(child, "exit");
    child.kill(); // Only the exact child created above, never an existing app.
    await exited;
    child = null;
    await withUnderstandingWriteLock(file, () => writeFile(file, "recovered"));
    assert.equal(await readFile(file, "utf8"), "recovered", "OS releases the dead writer's lock");
    await assert.rejects(withUnderstandingWriteLock(file, () => { throw new Error("fixture failure"); }), /fixture failure/);
    await withUnderstandingWriteLock(file, async () => {});
    await writeFile(file + ".lock", "");
    await assert.rejects(withUnderstandingWriteLock(file, () => writeFile(file, "unsafe")), /UNDERSTANDING_LEGACY_LOCK/);
    assert.equal(await readFile(file + ".lock", "utf8"), "", "legacy unknown-owner lock is never auto-deleted");
    const data = join(root, "store"), workspace = root;
    const a = await createProjectUnderstandingStore({ baseDirectory: data, workspaceRoot: workspace });
    const b = await createProjectUnderstandingStore({ baseDirectory: data, workspaceRoot: workspace });
    await Promise.all([a.setSettings({ useForContext: true }), b.setSettings({ autoCurate: true })]);
    await a.refresh();
    assert.equal(a.snapshot().settings.useForContext, true);
    assert.equal(a.snapshot().settings.autoCurate, true);
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, "exit"); child.kill(); await stopped; }
    assert(basename(root).startsWith("aporia-understanding-lock-"));
    await rm(root, { recursive: true, force: true });
  }
  console.log("Understanding OS-owned lock: active writer exclusion, crash release, exception release, legacy lock safety, queued updates: PASS");
}

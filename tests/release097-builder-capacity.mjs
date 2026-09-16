import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBuilderWorkspaceManager } from "../electron/harness/builder-workspace.js";
import { runWorkbenchGit } from "../electron/workbench/git-service.js";

// Bounded local capacity probe, not a throughput benchmark or a six-agent memory guarantee.
const root = await mkdtemp(join(tmpdir(), "aporiax-097-capacity-"));
const git = async (...args) => { const result = await runWorkbenchGit(root, args); assert.equal(result.code, 0, result.stderr); };
await git("init", "-b", "main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
await git("config", "commit.gpgsign", "false"); await git("config", "core.hooksPath", join(root, "no-hooks"));
const files = Array.from({ length: 6 }, (_, index) => `scope-${index}.txt`);
for (const file of files) await writeFile(join(root, file), Buffer.alloc(4_000_000, 65));
await git("add", "--", ...files); await git("commit", "-m", "capacity fixture");
const manager = createBuilderWorkspaceManager(), opened = [];
const started = performance.now(), initialRss = process.memoryUsage().rss;
let peakRss = initialRss;
const timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
async function diskBytes(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await diskBytes(child);
    else if (entry.isFile()) total += (await lstat(child)).size;
  }
  return total;
}
try {
  // allSettled ensures successful siblings are closed even if one worktree fails.
  const results = await Promise.allSettled(files.map(async (file, index) => {
    const worker = await manager.open({ workspaceRoot: root, agentId: `capacity-${index}`, writeScopes: [file] });
    opened.push(worker); return worker;
  }));
  assert.ok(results.every((result) => result.status === "fulfilled"), JSON.stringify(results));
  assert.equal(manager.leases().length, 6);
  let checkpointJsonBytes = 0, worktreeBytes = 0;
  for (const worker of opened) {
    await writeFile(join(worker.workspaceRoot, worker.writeScopes[0]), Buffer.alloc(4_000_000, 66));
    checkpointJsonBytes += Buffer.byteLength(JSON.stringify(await worker.snapshot()));
    worktreeBytes += await diskBytes(worker.workspaceRoot);
  }
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const result = { builders: opened.length, scopedBytesEach: 4_000_000, worktreeBytes, checkpointJsonBytes, nodeRssInitial: initialRss, nodeRssPeak: peakRss, elapsedMs: Math.round(performance.now() - started), scope: "Node parent RSS only; excludes Git child processes, model context and provider latency" };
  await writeFile(resolve(".tmp/release097-builder-capacity.json"), JSON.stringify(result, null, 2));
  console.log("PASS 0.9.7 capacity", JSON.stringify(result));
} finally {
  clearInterval(timer);
  await Promise.all(opened.map((worker) => worker.close()));
}
assert.equal(manager.leases().length, 0);

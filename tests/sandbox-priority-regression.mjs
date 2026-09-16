import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { runLocalSandboxedCommand } from "../electron/sandbox-runtime.js";
import { copyPrivateDependencies } from "../electron/sandbox-files.js";
import { appendSandboxRecoveryNotice } from "../electron/runtime/sandbox-recovery-notice.js";

const root = await mkdtemp(join(tmpdir(), "aporia-sandbox-p0-"));
const workspace = join(root, "workspace"), storage = join(root, "storage");
const opts = { workspaceRoot: workspace, cwd: workspace, localSandboxBaseDirectory: storage, runId: "run-fixture", taskId: "task-fixture", timeoutMs: 10000 };
const retained = [];
opts.onRecovery = (value) => retained.push(value);
const run = (command, extra = {}) => runLocalSandboxedCommand({ ...opts, command, ...extra });
const script = async (name, content) => { await writeFile(join(workspace, name + ".cjs"), content); return `node ${name}.cjs`; };
try {
  await mkdir(join(workspace, "node_modules", "probe"), { recursive: true });
  await writeFile(join(workspace, "node_modules", "probe", "value.txt"), "host dependency");
  await symlink(join(workspace, "node_modules/probe"), join(workspace, "node_modules/alias"), process.platform === "win32" ? "junction" : "dir");
  const command = await script("mutate", "require('fs').writeFileSync('node_modules/alias/value.txt','private');require('fs').writeFileSync('output.txt','delivered');");
  const result = await run(command);
  assert.equal(result.exitCode, 0); assert.equal(result.sandbox.sharedDependencies, "none");
  assert.equal(await readFile(join(workspace, "node_modules/probe/value.txt"), "utf8"), "host dependency");
  await mkdir(join(workspace, "packages/new-dep"), { recursive: true });
  await writeFile(join(workspace, "packages/new-dep/package.json"), JSON.stringify({ name: "local-sandbox-fixture", version: "1.0.0" }));
  const installed = await run(`npm install ./packages/new-dep --offline --ignore-scripts --no-audit --no-fund --cache "${join(root, "npm-cache")}"`);
  assert.equal(installed.exitCode, 0, installed.stderr);
  await assert.rejects(readFile(join(workspace, "node_modules/local-sandbox-fixture/package.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(workspace, "node_modules/probe/value.txt"), "utf8"), "host dependency");
  assert.equal(await readFile(join(workspace, "output.txt"), "utf8"), "delivered");
  await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { mutate: "node mutate.cjs" } }));
  assert.equal((await run("npm run mutate")).exitCode, 0);
  assert.equal(await readFile(join(workspace, "node_modules/probe/value.txt"), "utf8"), "host dependency");
  assert.deepEqual((await readdir(join(storage, "aporiax-local-sandbox"))).filter((name) => !name.startsWith(".")), []);

  await writeFile(join(workspace, "conflict.txt"), "baseline");
  const conflict = await script("conflict", "const fs=require('fs');fs.writeFileSync('conflict.txt','agent');fs.writeFileSync('new-output.txt','valuable');console.log('READY');setTimeout(()=>{},250);");
  let changed = false;
  await assert.rejects(run(conflict, { onOutput: ({ text }) => {
    if (!changed && text.includes("READY")) { changed = true; writeFileSync(join(workspace, "conflict.txt"), "user edit"); }
  } }), /original workspace changed/);
  const recovery = retained.at(-1);
  assert.equal(await readFile(join(workspace, "conflict.txt"), "utf8"), "user edit");
  assert.equal(await readFile(join(recovery.workspace, "new-output.txt"), "utf8"), "valuable");
  assert.equal(JSON.parse(await readFile(recovery.manifest)).runId, "run-fixture");
  assert.match(appendSandboxRecoveryNotice("Stopped", retained), /\[查看保留产物 1\]\(file:/);

  const failure = await script("failure", "require('fs').writeFileSync('failed-output.txt','keep me');process.exit(2);");
  const failed = await run(failure);
  assert.equal(failed.exitCode, 2); assert.equal(failed.sandbox.sync.applied, false);
  assert.equal(await readFile(join(retained.at(-1).workspace, "failed-output.txt"), "utf8"), "keep me");
  await assert.rejects(readFile(join(workspace, "failed-output.txt")), { code: "ENOENT" });

  const cancelled = await script("cancel", "require('fs').writeFileSync('cancel-output.txt','keep cancelled');console.log('READY');setInterval(()=>{},1000);");
  const abort = new AbortController();
  await assert.rejects(run(cancelled, { signal: abort.signal, onOutput: ({ text }) => { if (text.includes("READY")) abort.abort(); } }), { name: "AbortError" });
  assert.equal(await readFile(join(retained.at(-1).workspace, "cancel-output.txt"), "utf8"), "keep cancelled");
  const timed = await run(cancelled, { timeoutMs: 800 });
  assert.equal(timed.timedOut, true);
  assert.equal(await readFile(join(retained.at(-1).workspace, "cancel-output.txt"), "utf8"), "keep cancelled");

  await writeFile(join(workspace, "a.txt"), "old A"); await writeFile(join(workspace, "b.txt"), "old B");
  const writes = await script("writes", "const fs=require('fs');fs.writeFileSync('a.txt','new A');fs.writeFileSync('b.txt','new B');");
  let applied = 0;
  await assert.rejects(run(writes, { beforeApply: () => { if (++applied === 2) throw Object.assign(new Error("disk fault"), { code: "EACCES" }); } }), /disk fault/);
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "old A");
  assert.equal(await readFile(join(workspace, "b.txt"), "utf8"), "old B");
  assert.equal(await readFile(join(retained.at(-1).workspace, "a.txt"), "utf8"), "new A");
  assert.equal(await readFile(join(retained.at(-1).directory, "before/a.txt"), "utf8"), "old A");
  applied = 0;
  await assert.rejects(run(writes, { beforeApply: () => {
    if (++applied === 2) { writeFileSync(join(workspace, "a.txt"), "later user edit"); throw new Error("concurrent edit"); }
  } }), /concurrent edit/);
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "later user edit", "rollback must preserve a later edit");

  // Process death during sync leaves the journal, original backup and output on
  // disk. No long-lived child is launched: command already finished at this point.
  const crashScript = join(root, "crash.mjs");
  await writeFile(crashScript, `import {runLocalSandboxedCommand} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "electron/sandbox-runtime.js")).href)};let n=0;await runLocalSandboxedCommand({...${JSON.stringify({ ...opts, onRecovery: undefined })},command:'node writes.cjs',beforeApply:()=>{if(++n===2)process.exit(23);}});`);
  const crash = spawnSync(process.execPath, [crashScript], { windowsHide: true, timeout: 15000 });
  assert.equal(crash.status, 23, crash.stderr?.toString());
  const snapshots = (await readdir(join(storage, "aporiax-local-sandbox"))).filter((name) => !name.startsWith("."));
  const manifests = await Promise.all(snapshots.map(async (name) => ({ dir: join(storage, "aporiax-local-sandbox", name), data: JSON.parse(await readFile(join(storage, "aporiax-local-sandbox", name, "recovery.json"))) })));
  const orphan = manifests.find((item) => item.data.state === "applying");
  assert.ok(orphan, "crashed transaction stays discoverable");
  assert.equal(await readFile(join(orphan.dir, "before/a.txt"), "utf8"), "later user edit");
  assert.equal(await readFile(join(orphan.dir, "workspace/b.txt"), "utf8"), "new B");
  assert.equal((await run(writes)).exitCode, 0, "dead worker lock does not block future commands");

  // Independent dependency copies may not dereference a link outside workspace.
  await mkdir(join(root, "outside"));
  await writeFile(join(root, "outside/secret.txt"), "fixture only");
  await symlink(join(root, "outside"), join(workspace, "node_modules/external"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(run("node mutate.cjs"), /Dependency link escapes/);
  await assert.rejects(copyPrivateDependencies(join(workspace, "node_modules/probe"), join(root, "bounded"), workspace, { files: 0, bytes: 0, maxBytes: 1 }), /budget/);
  console.log("PASS sandbox P0: private dependencies/direct+project+offline-install, conflict, nonzero, abort, timeout, transactional rollback, user edits, crash recovery, external links, byte budgets.");
} finally { await rm(root, { recursive: true, force: true }); }

// Historical audit probe updated for v0.9.6 core fixes. Docker remains read-only diagnostics.
// Every write (including the simulated host file) stays in a generated temp tree.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLocalSandboxedCommand, buildDockerSandboxArgs, getSandboxStatus } from "../electron/sandbox-runtime.js";

const root = await mkdtemp(join(tmpdir(), "aporia-sandbox-audit-"));
try {
  const workspace = join(root, "workspace");
  const copies = join(root, "copies");
  await mkdir(join(workspace, "node_modules", "probe"), { recursive: true });
  const dependency = join(workspace, "node_modules", "probe", "value.txt");
  await writeFile(dependency, "original");
  await writeFile(join(workspace, "dependency.cjs"), "require('node:fs').writeFileSync('node_modules/probe/value.txt', 'modified-through-copy');");
  const base = { workspaceRoot: workspace, cwd: workspace, localSandboxBaseDirectory: copies, timeoutMs: 10000 };
  await runLocalSandboxedCommand({ ...base, command: "node dependency.cjs" });
  assert.equal(await readFile(dependency, "utf8"), "original");
  console.log("FIXED: safe workspace copy does not write through to host node_modules.");

  await writeFile(join(workspace, "conflict.txt"), "baseline");
  await writeFile(join(workspace, "conflict.cjs"), "const fs=require('node:fs');fs.writeFileSync('conflict.txt','agent');fs.writeFileSync('new-output.txt','valuable result');console.log('AUDIT_READY');setTimeout(()=>{},250);");
  let changed = false;
  await assert.rejects(runLocalSandboxedCommand({ ...base, command: "node conflict.cjs", onOutput: (output) => {
    if (!changed && String(output.text).includes("AUDIT_READY")) {
      changed = true;
      writeFileSync(join(workspace, "conflict.txt"), "concurrent user edit");
    }
  } }), /original workspace changed/);
  assert.equal(changed, true);
  assert.equal(await readFile(join(workspace, "conflict.txt"), "utf8"), "concurrent user edit");
  await assert.rejects(readFile(join(workspace, "new-output.txt")), { code: "ENOENT" });
  const kept = (await readdir(join(copies, "aporiax-local-sandbox"))).filter((name) => !name.startsWith("."));
  assert.equal(kept.length, 1);
  assert.equal(await readFile(join(copies, "aporiax-local-sandbox", kept[0], "workspace/new-output.txt"), "utf8"), "valuable result");
  console.log("FIXED: conflict protects user edit AND retains new output in recovery storage.");

  const args = buildDockerSandboxArgs({ command: "true", workspaceRoot: workspace, containerName: "audit-not-started" });
  assert.ok(args.includes(workspace + ":/workspace:rw"));
  assert.ok(args.includes("none"));
  console.log("CONFIRMED (argument construction only): Docker mounts the real workspace read/write; it is not a rollback copy.");
  const status = await getSandboxStatus();
  console.log(JSON.stringify({ dockerReady: status.available, state: status.state, detail: status.detail }));
} finally { await rm(root, { recursive: true, force: true }); }

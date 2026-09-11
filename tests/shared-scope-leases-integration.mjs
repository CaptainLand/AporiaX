import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BuilderWorkspaceManager } from "../electron/harness/builder-workspace.js";
import { HarnessScheduler } from "../electron/harness/scheduler.js";
import { sharedScopeLeases } from "../electron/harness/shared-scope-leases.js";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function flipCasePath(value) {
  const chars = [...value];
  const index = chars.findIndex((ch) => /[A-Za-z]/.test(ch));
  if (index < 0) return value;
  chars[index] = chars[index] === chars[index].toUpperCase() ? chars[index].toLowerCase() : chars[index].toUpperCase();
  return chars.join("");
}

async function initRepo(prefix) {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "aporiax-lease@example.invalid"]);
  git(repo, ["config", "user.name", "AporiaX Lease"]);
  await mkdir(join(repo, "src", "auth"), { recursive: true });
  await writeFile(join(repo, "src", "auth", "login.js"), "export const login = false;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "baseline"]);
  return repo;
}

const firstEvents = [];
const secondEvents = [];
const repoA = await initRepo("aporia-lease-a-");
const repoB = await initRepo("aporia-lease-b-");
const kernel = new BuilderWorkspaceManager({ eventBus: { emit: (event) => firstEvents.push(event) } });
const orchestration = new BuilderWorkspaceManager({ eventBus: { emit: (event) => secondEvents.push(event) } });
let sessionA = null;
let sessionB = null;
let sessionOther = null;
try {
  sessionA = await kernel.open({ workspaceRoot: repoA, agentId: "kernel-auth", writeScopes: ["src/auth"] });
  assert.notEqual(await realpath(sessionA.workspaceRoot), await realpath(repoA), "Builder must not fall back to the parent workspace");
  assert.equal(firstEvents.filter((event) => event.type === "builder.workspace.created").length, 1);

  await assert.rejects(
    () => orchestration.open({ workspaceRoot: repoA, agentId: "orch-auth", writeScopes: ["src/auth"] }),
    /conflicts with an active worker/,
  );
  assert.equal((await readFile(join(repoA, "src", "auth", "login.js"), "utf8")).replace(/\r\n/g, "\n"), "export const login = false;\n");
  assert.equal(secondEvents.filter((event) => event.type === "builder.workspace.created").length, 0);
  assert.ok(sharedScopeLeases.list().some((lease) => lease.owner === "kernel-auth"));

  sessionOther = await orchestration.open({
    workspaceRoot: repoB,
    agentId: "kernel-auth",
    writeScopes: ["src/auth"],
  });
  assert.equal((await readFile(join(sessionOther.workspaceRoot, "src", "auth", "login.js"), "utf8")).replace(/\r\n/g, "\n"), "export const login = false;\n");

  if (process.platform === "win32") {
    const aliased = flipCasePath(repoA);
    await assert.rejects(
      () => orchestration.open({ workspaceRoot: aliased, agentId: "case-auth", writeScopes: ["src/auth"] }),
      /conflicts with an active worker/,
    );
  }

  await sessionA.close();
  sessionA = null;
  sessionB = await orchestration.open({ workspaceRoot: repoA, agentId: "orch-auth", writeScopes: ["src/auth"] });
  await writeFile(join(sessionB.workspaceRoot, "src", "auth", "login.js"), "export const login = true;\n");
  const merged = await sessionB.merge();
  assert.equal(merged.merged, true);
  assert.equal((await readFile(join(repoA, "src", "auth", "login.js"), "utf8")).replace(/\r\n/g, "\n"), "export const login = true;\n");
  await sessionB.close();
  sessionB = null;

  const schedulerEvents = [];
  const scheduler = new HarnessScheduler({
    eventBus: { emit: (event) => schedulerEvents.push(event) },
  });
  const queued = scheduler.enqueue({
    id: "run-lease:builder:auth",
    kind: "builder",
    metadata: { runId: "run-lease", parentTaskId: "task-lease" },
    run: async () => "ok",
  });
  assert.equal(await queued.promise, "ok");
  assert.equal(schedulerEvents.filter((event) => event.type === "scheduler.queued").length, 1);
  assert.equal(schedulerEvents.filter((event) => event.type === "scheduler.started").length, 1);
  assert.equal(schedulerEvents.filter((event) => event.type === "scheduler.completed").length, 1);
  assert.equal(schedulerEvents[0].runId, "run-lease");
  assert.equal(schedulerEvents[0].parentTaskId, "task-lease");
  assert.match(schedulerEvents[0].jobId, /^run-lease:/);

  assert.equal(sharedScopeLeases.list().length, 1, "only the other-repo lease should remain");
  await sessionOther.close();
  sessionOther = null;
  assert.equal(sharedScopeLeases.list().length, 0);

  console.log("Shared scope leases, isolated worktrees, scheduler run correlation: PASS");
} finally {
  await sessionA?.close().catch(() => undefined);
  await sessionB?.close().catch(() => undefined);
  await sessionOther?.close().catch(() => undefined);
  await rm(repoA, { recursive: true, force: true });
  await rm(repoB, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskHistoryStore } from "../electron/task-history-store.js";
import { createControlStore } from "../electron/control/store.js";
import { createLocalControlService } from "../electron/control/service.js";
import { createDesktopLocalControl } from "../electron/control/desktop-runtime.js";

const temp = await mkdtemp(join(tmpdir(), "aporiax-existing-workspaces-"));
const one = join(temp, "project-one"), two = join(temp, "project-two"), missing = join(temp, "missing");
let service;
let desktop;
try {
  await mkdir(one); await mkdir(two);
  await writeFile(join(temp, "not-a-directory"), "fixture");
  const history = createTaskHistoryStore(join(temp, "data"));
  const task = (id, path, name) => ({ id, workspacePath: path, workspaceName: name, messages: [{ role: "user", content: "PRIVATE_TASK_BODY" }] });
  const save = async tasks => {
    const old = await history.loadSnapshot();
    await history.saveTasks(tasks, { expectedRevision: old.revision, deletedTaskIds: (old.tasks || []).filter(item => !tasks.some(next => next.id === item.id)).map(item => item.id) });
  };
  await save([task("task-one", one, "Project One"), task("task-duplicate", one, "Same folder"), task("task-two", two, "Project Two"),
    task("task-missing", missing, "Missing"), task("task-unbound", null, "Chat only"), task("task-file", join(temp, "not-a-directory"), "File")]);
  const listWorkspaces = async () => ((await history.loadTasks()) || []).map(item => ({ path: item.workspacePath, label: item.workspaceName }));
  // An existing grant for the same actual folder survives the migration.
  const oldStore = await createControlStore(join(temp, "data", "local-control"));
  oldStore.putWorkspace({ id: "ws-existing", path: await realpath(one), label: "Old name" });
  oldStore.putWorkspace({ id: "ws-legacy-only", path: temp, label: "Not a desktop project" });
  oldStore.close();
  const callbacks = new Map(), starts = [];
  const runtime = { interrupt() { return true; } };
  const options = { dataDirectory: join(temp, "data"), taskRuntime: runtime, listWorkspaces,
    listProviders: () => [{ id: "fixture", models: [{ id: "model" }] }],
    startRun: async (request, context) => { starts.push(request); callbacks.set(request.runId, context); return { runId: request.runId }; },
  };
  service = await createLocalControlService(options);
  const first = (await service.admin("status")).workspaces;
  assert.equal(first.length, 2);
  assert.equal(first.find(item => item.label === "Project One").id, "ws-existing");
  assert.equal(JSON.stringify(first).includes("PRIVATE_TASK_BODY"), false);
  assert.equal(first.some(item => item.id === "ws-legacy-only"), false);
  const ws = first.find(item => item.id === "ws-existing"), other = first.find(item => item.id !== ws.id);
  const rejectCode = (fn, code) => assert.rejects(fn, error => error.code === code);
  await rejectCode(() => service.admin("registerWorkspace", { path: temp }), "desktop_workspaces_managed");
  await rejectCode(() => service.admin("removeWorkspace", { workspaceId: ws.id }), "desktop_workspaces_managed");
  const grant = { name: "Fixture", workspaceIds: [ws.id], profiles: ["review"], providerIds: ["fixture"], maxConcurrentRuns: 1 };
  await rejectCode(() => service.admin("createClient", { ...grant, workspaceIds: ["ws-legacy-only"] }), "unknown_workspace");
  const issued = await service.admin("createClient", grant);
  await service.admin("setEnabled", { enabled: true });
  const client = service.authenticate(issued.token);
  const call = (method, path, body = {}) => service.dispatch(client, method, `/control/v1${path}`, {}, body);
  assert.deepEqual((await call("GET", "/workspaces")).workspaces.map(item => item.id), [ws.id]);
  const request = id => ({ workspace_id: ws.id, profile: "review", instruction: "Fixture task", idempotency_key: id });
  await rejectCode(() => call("POST", "/runs", { ...request("denied"), workspace_id: other.id }), "scope_denied");
  const eventual = async fn => {
    for (let i = 0; i < 300; i++) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail("Timed out waiting for local workspace test");
  };
  const active = await call("POST", "/runs", request("active"));
  await eventual(() => callbacks.has(active.run_id));
  const queued = await call("POST", "/runs", request("queued"));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(starts.length, 1, "async catalog lookup must not bypass concurrency slots");
  await save([task("task-one", one, "Renamed project"), task("task-two", two, "Project Two")]);
  assert.equal((await service.admin("status")).workspaces.find(item => item.label === "Renamed project").id, ws.id);
  // Retargeting the same task to another directory must not move its grant.
  await save([task("task-one", two, "Renamed project")]);
  assert.equal((await call("GET", "/workspaces")).workspaces.length, 0);
  await rejectCode(() => call("POST", "/runs", request("removed")), "workspace_not_found");
  await callbacks.get(active.run_id).onResult({ status: "completed", content: "Fixture finished" });
  await eventual(async () => (await service.admin("getRun", { runId: queued.run_id })).status === "blocked");
  assert.equal(starts.length, 1, "removed queued workspace must not execute");
  await service.shutdown(); service = null;
  service = await createLocalControlService(options);
  const afterRestart = (await service.admin("status")).workspaces;
  assert.equal(afterRestart[0].id, other.id, "catalog IDs stay stable across restart");
  await service.shutdown(); service = null;

  // Main-process lifecycle passes the catalog through; permissions are readable
  // independently, without a listener or a successful workspace catalog read.
  desktop = await createDesktopLocalControl({ dataDirectory: join(temp, "desktop"), taskRuntime: runtime,
    startHarnessTask: () => { throw new Error("Should not execute"); }, listWorkspaces,
    fileAccessSettings: { snapshot: () => ({ enabled: false }) } });
  assert.equal((await desktop.request({ action: "status" })).workspaces[0].id, other.id);
  assert.deepEqual(await desktop.request({ action: "getFileAccess" }), { enabled: false });
  assert.equal((await desktop.request({ action: "status" })).enabled, false);
  console.log("PASS existing desktop workspaces: saved project source, dedupe, missing/file/unbound exclusion, legacy path compatibility, stable IDs, rename, retarget scope, queued recheck, concurrency, restart, desktop adapter, independent permissions");
} finally {
  await desktop?.shutdown(); await service?.shutdown();
  // Only the exact mkdtemp-owned test directory is removed.
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureNativeFileAccess, verifyNativeFileTarget, withNativeFileScope } from "../electron/runtime/file-access-policy.js";
import { createFileAccessSettings } from "../electron/runtime/file-access-settings.js";
import { createNativeToolExecutor } from "../electron/runtime/native-tool-executor.js";
import { dispatchNativeTool } from "../electron/runtime/tool-dispatcher.js";
import { TOOL_REGISTRY } from "../electron/runtime/native-tool-catalog.js";
import { createPermissionPolicy } from "../electron/agent-core.js";
import { calculateLineChanges, searchWorkspaceText, verifyExistingTarget, verifyWritableTarget, runGitCommand } from "../electron/runtime/workspace-runtime.js";
import { createLocalControlPolicy, withLocalControlPolicy, assertLocalControlTool } from "../electron/control/policy.js";
import { mutateWorkspaceFiles } from "../electron/runtime/workspace-mutations.js";
import { sameSnapshotIdentity } from "../electron/control/workspaces.js";
import { protectPrivatePath } from "../electron/control/credentials.js";

const temp = await mkdtemp(join(tmpdir(), "aporiax-global-file-test-"));
const workspace = join(temp, "Workspace"), outside = join(temp, "outside"), data = join(temp, "app-data");
let checks = 0;
const check = async (name, run) => { await run(); checks++; console.log(`PASS ${name}`); };
const denied = callback => assert.rejects(callback, error => ["FILE_ACCESS_DENIED", "LOCAL_CONTROL_FORBIDDEN"].includes(error.code));
const executor = createNativeToolExecutor({ verifyExistingTarget, verifyWritableTarget, searchWorkspaceText, calculateLineChanges, runGitCommand });
const invoke = (toolName, input, options = {}) => dispatchNativeTool({
  toolCall: { id: `test-${checks}`, function: { name: toolName, arguments: JSON.stringify(input) } },
  registry: TOOL_REGISTRY, permissionPolicy: createPermissionPolicy("workspace-write"),
  parseArguments: call => JSON.parse(call.function.arguments),
  requestApproval: async () => ({ approved: true }),
  executeContext: { workspaceRoot: workspace }, executeAuthorized: executor, ...options,
});
try {
  await Promise.all([workspace, outside, data].map(path => mkdir(path)));
  const file = join(outside, "note.txt");
  await writeFile(file, "outside original\n");
  await writeFile(join(workspace, "inside.txt"), "inside\n");
  let settings = await createFileAccessSettings({ dataDirectory: data });
  configureNativeFileAccess(settings.policy);
  await check("default off; real desktop file tools cannot escape", async () => {
    assert.equal(settings.snapshot().enabled, false);
    await denied(() => invoke("read_external_file", { path: outside }, { executeContext: {} }));
    await denied(() => invoke("read_external_file", { path: "inside.txt" }));
    if (process.platform === "win32") {
      // These spellings must not be validated against the workspace and then
      // interpreted as drive-root paths by the directory/file reader.
      await denied(() => invoke("read_external_file", { path: "/inside.txt" }));
      await denied(() => invoke("read_external_file", { path: "/" }));
    }
    for (const toolName of ["read_file", "read_external_file", "list_directory", "search_text", "write_file", "apply_patch"]) {
      await denied(() => invoke(toolName, { path: toolName === "list_directory" || toolName === "search_text" ? outside : file, content: "bad", search: "original", replace: "bad", query: "outside" }));
    }
    assert.match((await invoke("read_file", { path: "inside.txt" })).modelResult.content, /inside/);
    await assert.rejects(() => settings.set({ enabled: true }), /risk confirmation/);
  });
  await check("confirmed setting persists; real create, edit, patch, read and search", async () => {
    await settings.set({ enabled: true, riskAcknowledged: true });
    settings = await createFileAccessSettings({ dataDirectory: data });
    configureNativeFileAccess(settings.policy);
    assert.equal(settings.snapshot().enabled, true);
    await invoke("write_file", { path: file, content: "outside updated\n" });
    const fresh = join(outside, "new", "file.txt");
    await invoke("write_file", { path: fresh, content: "fresh\n" });
    assert.equal(await readFile(fresh, "utf8"), "fresh\n");
    await invoke("apply_patch", { path: file, old_text: "updated", new_text: "patched" });
    assert.equal(await readFile(file, "utf8"), "outside patched\n");
    assert.match((await invoke("read_external_file", { path: file })).modelResult.content, /patched/);
    assert((await invoke("search_text", { path: outside, query: "patched" })).modelResult.results.length);
  });
  await check("external edit grants use global policy; read-only and commands do not elevate", async () => {
    const grant = permissionProfile => createLocalControlPolicy({ workspaceRoot: workspace, permissionProfile });
    await withLocalControlPolicy(grant("workspace_edit"), () => invoke("write_file", { path: file, content: "external client\n" }));
    await withLocalControlPolicy(grant("read_only"), async () => {
      assert.match((await invoke("read_file", { path: file })).modelResult.content, /external client/);
      await denied(() => invoke("write_file", { path: file, content: "not allowed" }));
      await denied(() => invoke("run_command", { command: "echo forbidden", cwd: outside }));
    });
    await withLocalControlPolicy(createLocalControlPolicy({ workspaceRoot: workspace, permissionProfile: "workspace_edit", capabilities: { commands: true } }), async () => {
      await denied(() => assertLocalControlTool({ toolName: "run_command", input: { cwd: outside }, workspaceRoot: workspace }));
    });
    await assert.rejects(() => invoke("write_file", { path: file, content: "not allowed" }, { permissionPolicy: createPermissionPolicy("read-only") }), /Permission denied/);
  });
  await check("application credentials, config, metadata and protected search descendants", async () => {
    await writeFile(join(data, "aporiax-account-session.json"), "needle-private");
    await writeFile(join(data, "public.txt"), "needle-public");
    await writeFile(join(outside, ".env"), "needle-secret");
    for (const path of [join(data, "security", "file-access.json"), join(data, "aporiax-account-session.json"), join(outside, ".env")]) {
      await denied(() => invoke("read_file", { path }));
      await denied(() => invoke("write_file", { path, content: "bad" }));
    }
    await denied(() => invoke("write_file", { path: join(outside, ".git", "config"), content: "bad" }));
    const result = await invoke("search_text", { path: data, query: "needle" });
    assert.equal(result.modelResult.results.length, 1);
    assert.match(result.modelResult.results[0].preview, /needle-public/);
  });
  await check("global revocation while approval waits stops the real executor", async () => {
    await denied(() => invoke("read_external_file", { path: file }, { permissionPolicy: createPermissionPolicy("workspace-write", { read_external_file: "ask" }), requestApproval: async () => { await settings.set({ enabled: false }); return { approved: true }; } }));
    await denied(() => invoke("write_file", { path: file, content: "bad" }));
    assert.equal(await readFile(file, "utf8"), "external client\n");
  });
  await check("recheck after prepared journal; cancelled authority cannot commit", async () => {
    await settings.set({ enabled: true, riskAcknowledged: true });
    await assert.rejects(() => withNativeFileScope("write_file", workspace, () => mutateWorkspaceFiles({ workspaceRoot: workspace,
      edits: [{ path: file, before: Buffer.from("external client\n"), after: Buffer.from("bad") }], recoveryDirectory: join(temp, "recovery"),
      onPrepared: () => settings.set({ enabled: false }),
    })), /FILE_ACCESS_DENIED/);
    assert.equal(await readFile(file, "utf8"), "external client\n");
  });
  await check("junction escapes cannot implicitly broaden scope; alias cannot expose secrets", async () => {
    await settings.set({ enabled: true, riskAcknowledged: true });
    await symlink(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
    await denied(() => invoke("read_file", { path: "escape/note.txt" }));
    await symlink(join(data, "security"), join(outside, "alias"), process.platform === "win32" ? "junction" : "dir");
    await denied(() => invoke("read_file", { path: join(outside, "alias", "file-access.json") }));
    if (process.platform === "win32") {
      const policy = createLocalControlPolicy({ workspaceRoot: workspace.toLowerCase(), permissionProfile: "read_only" });
      await withLocalControlPolicy(policy, () => assertLocalControlTool({ toolName: "read_file", input: { path: "inside.txt" }, workspaceRoot: workspace }));
    }
  });
  await check("snapshot identity tolerates only old Windows unknown path device", async () => {
    const a = { size: 1n, ino: 24206847997491165n, dev: 5n, mtimeNs: 1n, ctimeNs: 2n };
    const options = { pathVsHandle: true, platform: "win32" };
    assert(sameSnapshotIdentity(a, { ...a, dev: 0n }, options));
    assert(!sameSnapshotIdentity(a, { ...a, dev: 0n }));
    for (const key of ["size", "ino", "mtimeNs", "ctimeNs"]) assert(!sameSnapshotIdentity(a, { ...a, dev: 0n, [key]: a[key] + 1n }, options));
    assert(!sameSnapshotIdentity(a, { ...a, dev: 9n }, options));
  });
  await check("ACL child environment does not leak PS7 module resolution", async () => {
    let env;
    await protectPrivatePath(join(temp, "fixture"), { platform: "win32", exec: async (_exe, _args, options) => { env = options.env; } });
    assert(!Object.keys(env).some(key => key.toLowerCase() === "psmodulepath"));
  });
  await settings.set({ enabled: false });
  console.log(`Global native file access: PASS (${checks} groups)`);
} finally {
  configureNativeFileAccess(() => ({ enabled: false }));
  // Exact mkdtemp-owned root, never a user workspace or computed home path.
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

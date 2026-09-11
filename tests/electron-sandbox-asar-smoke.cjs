const assert = require("node:assert/strict");
const { app } = require("electron");
const fs = require("original-fs").promises;
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
app.whenReady().then(async () => {
  const temp = await fs.mkdtemp(join(tmpdir(), "aporia-asar-"));
  try {
    const { createPackage } = await import("@electron/asar");
    const source = join(temp, "archive-source");
    const root = join(temp, "workspace");
    await fs.mkdir(source); await fs.mkdir(join(root, "release", "resources"), { recursive: true });
    await fs.writeFile(join(source, "hello.txt"), "archive content");
    const archive = join(root, "release", "resources", "app.asar");
    await createPackage(source, archive);
    const before = await fs.readFile(archive);
    const { runLocalSandboxedCommand } = await import(pathToFileURL(join(__dirname, "../electron/sandbox-runtime.js")).href);
    const result = await runLocalSandboxedCommand({ workspaceRoot: root, cwd: root, command: "node --version", signal: new AbortController().signal });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.match(result.stdout, /v\d+\./);
    assert.deepEqual(await fs.readFile(archive), before, "ASAR must stay intact, not expand into a virtual directory");
    console.log("Actual Electron workspace sandbox with a nested release/app.asar: PASS");
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });

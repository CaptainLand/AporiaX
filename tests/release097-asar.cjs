const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("original-fs").promises;
const { resolve, join } = require("node:path");
const { pathToFileURL } = require("node:url");
app.whenReady().then(async () => {
  const parent = resolve(".tmp"); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(join(parent, "ocr-asar-"));
  let service;
  try {
    const source = join(root, "source"); await fs.mkdir(source);
    await fs.writeFile(join(source, "package.json"), JSON.stringify({ name: "ocr-fixture", version: "1.0.0", type: "module" }));
    await fs.cp(resolve("electron/ocr"), join(source, "electron/ocr"), { recursive: true });
    const pkg = JSON.parse(await fs.readFile(resolve("package.json"), "utf8"));
    const dependencies = pkg.build.asarUnpack.filter((pattern) => pattern.startsWith("node_modules/") && !pattern.includes("ripgrep") && !pattern.includes("typescript")).map((pattern) => pattern.replace(/\/\*\*\/\*$/, ""));
    for (const path of dependencies) await fs.cp(resolve(path), join(source, path), { recursive: true });
    const { createPackageWithOptions } = await import("@electron/asar");
    const archive = join(root, "app.asar");
    await createPackageWithOptions(source, archive, { unpackDir: "" , unpack: "*" });
    const { createOcrService } = await import(pathToFileURL(join(archive, "electron/ocr/service.js")));
    service = createOcrService({ directory: resolve(".tmp/ocr-097-models") });
    let job = await service.start({ data: await fs.readFile(resolve(".tmp/ocr-097-fixture.pdf")), name: "packaged.pdf", from: 1, to: 2 }, "asar");
    const deadline = Date.now() + 60000;
    while (job.state === "running" && Date.now() < deadline) { await new Promise((done) => setTimeout(done, 100)); job = service.get(job.id, "asar"); }
    assert.equal(job.state, "completed", JSON.stringify(job)); assert.match(job.pages[1].text, /Hello World/);
    console.log("PASS Electron ASAR/unpacked OCR: isolated dependency set, PDF fonts, native canvas, nested worker, WASM languages");
  } finally {
    service?.dispose();
    assert.ok(root.startsWith(join(parent, "ocr-asar-")));
    // Electron retains the ASAR file handle until process exit on Windows.
    // Leave the isolated fixture for the outer runner to clean after exit.
    console.log("ASAR fixture:", root);
  }
}).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });

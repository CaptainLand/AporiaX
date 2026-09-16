const { app } = require("electron");
const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { readFile } = require("node:fs/promises");
app.whenReady().then(async () => {
  const { createOcrService } = await import(pathToFileURL(resolve("electron/ocr/service.js")));
  const service = createOcrService({ directory: resolve(".tmp/ocr-097-models") });
  try {
    let job = await service.start({ data: await readFile(resolve(".tmp/ocr-097-fixture.png")), name: "fixture.png" }, "electron");
    const deadline = Date.now() + 60000;
    while (job.state === "running" && Date.now() < deadline) { await new Promise((done) => setTimeout(done, 100)); job = service.get(job.id, "electron"); }
    assert.equal(job.state, "completed", JSON.stringify(job)); assert.match(job.pages[0].text, /Hello World/);
    console.log("PASS 0.9.7 actual Electron 39: native canvas, nested OCR worker, WASM, Chinese/English resources");
  } finally { service.dispose(); }
}).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });

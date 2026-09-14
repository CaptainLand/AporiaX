const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

// Verify the production file:// origin and CSP, not just Vite's HTTP origin.
// This does not start AporiaX, load account state, or call any external service.
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error("Document frame test timed out"); app.exit(1); }, 15000);
app.whenReady().then(async () => {
  let window;
  try {
    const preview = path.resolve("dist/document-preview.html");
    assert.equal(await fs.readFile(preview, "utf8"), await fs.readFile("public/document-preview.html", "utf8"), "Production preview must be current; run npm run build first");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aporiax-document-frame-"));
    const html = path.join(root, "parent.html");
    await fs.writeFile(html, '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data:"><title>Document CSP test</title>');
    window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await window.loadFile(html);
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.sandbox = 'allow-same-origin';
      frame.src = ${JSON.stringify(pathToFileURL(preview).href)};
      frame.onload = () => {
        try {
          const doc = frame.contentDocument;
          const pages = doc.getElementById('pages');
          const style = doc.createElement('style');
          style.textContent = '.document-test { color: rgb(36, 106, 146); font-weight: bold; }';
          doc.head.appendChild(style);
          const paragraph = doc.createElement('p');
          paragraph.className = 'document-test'; paragraph.textContent = 'Word style'; pages.appendChild(paragraph);
          const script = doc.createElement('script'); script.textContent = 'window.documentScriptRan = true'; doc.body.appendChild(script);
          const computed = frame.contentWindow.getComputedStyle(paragraph);
          resolve({ color: computed.color, weight: computed.fontWeight, scriptRan: !!frame.contentWindow.documentScriptRan, bridge: typeof frame.contentWindow.desktop });
        } catch (error) { reject(error); }
      };
      document.body.appendChild(frame);
    })`);
    assert.equal(result.color, "rgb(36, 106, 146)");
    assert.equal(result.weight, "700");
    assert.equal(result.scriptRan, false);
    assert.equal(result.bridge, "undefined");
    console.log("PASS: production Electron file:// document iframe keeps styles, blocks scripts, and has no desktop bridge.");
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    clearTimeout(deadline); window?.destroy(); app.exit(process.exitCode || 0);
  }
});

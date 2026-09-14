const { app, nativeImage } = require("electron");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
app.whenReady().then(() => {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  assert.equal(pkg.build.win.icon, "icon-dark.ico", "EXE icon must use the same large AX asset as the window/tray");
  assert.ok(pkg.build.files.includes("build/" + pkg.build.win.icon));
  const source = readFileSync(resolve("electron/main.js"), "utf8");
  assert.match(source, /const candidates = \[\s*join\(projectRoot, "build", "icon-dark.ico"\)/);
  const bytes = readFileSync(resolve("build", pkg.build.win.icon));
  const widths = [], coverage = [];
  for (let i = 0; i < bytes.readUInt16LE(4); i++) {
    const entry = 6 + 16 * i, size = bytes[entry] || 256;
    const offset = bytes.readUInt32LE(entry + 12), length = bytes.readUInt32LE(entry + 8);
    const icon = nativeImage.createFromBuffer(bytes.subarray(offset, offset + length));
    assert.equal(icon.isEmpty(), false); assert.equal(icon.getSize().width, size);
    widths.push(size);
    const rgba = icon.toBitmap(); let left = size, right = -1;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4, b = rgba[p], g = rgba[p + 1], r = rgba[p + 2];
      if (rgba[p + 3] > 128 && b > 120 && g > r * 1.3 && b > r * 1.5) { left = Math.min(left, x); right = Math.max(right, x); }
    }
    const ratio = (right - left + 1) / size;
    assert.ok(ratio >= .65, `AX mark too small at ${size}px: ${ratio}`);
    coverage.push(`${size}px:${Math.round(ratio * 100)}%`);
  }
  for (const size of [16, 24, 32, 48, 64, 128, 256]) assert.ok(widths.includes(size));
  assert.equal(nativeImage.createFromPath(resolve("build", pkg.build.win.icon)).isEmpty(), false);
  console.log("PASS: package/runtime icon aligned, all Windows ICO resolutions readable, visible AX width " + coverage.join(", "));
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });

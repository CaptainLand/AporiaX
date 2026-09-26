import { build, Platform, Arch } from "electron-builder";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { extractFile } from "@electron/asar";
const version = "1.0.0-preview.2.beta.1";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const output = resolve("release/v" + version);
const r = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], { stdio: "inherit", windowsHide: true });
if (r.status !== 0) throw new Error("Desktop build failed");
await build({ targets: Platform.WINDOWS.createTarget(["portable"], Arch.x64), publish: "never",
  config: { ...pkg.build, appId: "com.aporiax.desktop.friendsbeta", productName: "AporiaX Beta",
    directories: { ...pkg.build.directories, output }, publish: null,
    extraMetadata: { version, name: "aporiax-desktop-beta", productName: "AporiaX Beta", main: "electron/main-friends-beta.js" },
    files: [...pkg.build.files.filter(file => file !== "config/cloud-endpoints.json"),
      { from: ".tmp/friends-beta-build", to: "config", filter: ["cloud-endpoints.json"] }],
    portable: { ...pkg.build.portable, artifactName: "AporiaX-Beta-Portable-${version}-${arch}.${ext}" },
  },
});
assert.deepEqual(extractFile(resolve(output, 'win-unpacked/resources/app.asar'), 'config/cloud-endpoints.json'), readFileSync('.tmp/friends-beta-build/cloud-endpoints.json'));
console.log(output);

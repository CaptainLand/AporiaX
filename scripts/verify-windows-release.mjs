import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { extractFile, listPackage, statFile } from "@electron/asar";
import yaml from "js-yaml";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const version = pkg.version;
const output = resolve(process.argv[2] || `release/v${version}`);
const archive = join(output, "win-unpacked/resources/app.asar");
const packagedFile = (file) => extractFile(archive, normalize(file));
const packaged = JSON.parse(extractFile(archive, "package.json"));
assert.equal(packaged.version, version);
assert.equal(packaged.main, pkg.main);
const hash = (data, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(data).digest(encoding);
async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path.replaceAll("\\", "/"));
  }
  return result;
}
const sources = [...await files("electron"), ...await files("shared"), ...await files("dist"), "build/icon.ico", "build/icon-dark.ico"];
try { await stat("config/cloud-endpoints.json"); sources.push("config/cloud-endpoints.json"); } catch (error) { if (error.code !== "ENOENT") throw error; }
for (const file of sources) assert.equal(hash(packagedFile(file)), hash(await readFile(file)), `Stale/missing packaged source: ${file}`);
for (const name of ["@xterm/addon-search", "docx-preview", "node-pty"]) {
  const installed = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8"));
  assert.equal(JSON.parse(packagedFile(`node_modules/${name}/package.json`)).version, installed.version);
}
const entries = listPackage(archive).map((path) => path.replaceAll("\\", "/").replace(/^\//, ""));
for (const name of ["builder-util-runtime", "graceful-fs", "js-yaml", "lazy-val", "zod", "jszip"]) {
  assert.ok(entries.includes("node_modules/" + name + "/package.json"), "Missing packaged runtime dependency: " + name);
}
for (const file of ["electron/account/remote-file-broker.js", "electron/account/remote-command-inbox.js", "src/account/remote-sync.js"]) {
  assert.ok(!entries.includes(file), `Retired mobile channel must not ship: ${file}`);
}
const retiredChannel = /\/remote\/(?:desktop|mobile)|account:(?:sync-tasks|remote-commands|set-remote-enabled|set-remote-file-access|claim-remote-command|ack-remote-command|execute-remote-file-command)|buildRemoteTaskSyncPayload|uploadRemoteCommandFile|createRemoteCommandInbox|MOBILE_COMPANION_ENABLED|remoteServiceSupported/;
for (const file of entries.filter((path) => /^(?:electron|dist|shared)\/.*\.(?:js|cjs|mjs)$/.test(path))) {
  assert.doesNotMatch(packagedFile(file).toString("utf8"), retiredChannel, `Retired mobile channel in package: ${file}`);
}
assert.ok(entries.some((path) => /node-pty\/.*pty\.node$/.test(path)), "Missing native PTY module");
const natives = entries.filter((path) => /node-pty\/.*\.(node|dll|exe)$/.test(path));
for (const path of natives) {
  assert.equal(statFile(archive, normalize(path)).unpacked, true, `Native PTY binary not unpacked: ${path}`);
  assert.ok((await stat(archive + ".unpacked/" + path)).size > 0);
}
for (const name of [".env", "aporiax-providers.json", "deepseek-credentials.json", "aporiax-tasks.json", "aporiax-mobile", ".tmp", "tests"]) {
  assert.ok(!entries.some((path) => path === name || path.startsWith(name + "/")), `Unexpected private/development artifact: ${name}`);
}
const setup = `AporiaX-Setup-${version}-x64.exe`, portable = `AporiaX-Portable-${version}-x64.exe`;
const channel = version.includes("-") ? version.split("-")[1].split(".")[0] : "latest";
// Local --publish never builds can still emit latest.yml for a prerelease,
// depending on the configured publisher. Validate its exact version below.
const updateFile = (await readdir(output)).includes(channel + ".yml") ? channel + ".yml" : "latest.yml";
const names = [...new Set([setup, portable, setup + ".blockmap", updateFile, "latest.yml"])];
const blobs = new Map();
for (const name of names) blobs.set(name, await readFile(join(output, name)));
for (const name of [setup, portable]) {
  assert.equal(blobs.get(name).subarray(0, 2).toString(), "MZ");
  assert.ok(blobs.get(name).length > 50_000_000, `Suspiciously small package: ${name}`);
}
const metadata = yaml.load(blobs.get(updateFile).toString());
assert.deepEqual(yaml.load(blobs.get("latest.yml").toString()), metadata, "Default update channel must match the release");
assert.equal(metadata.version, version); assert.equal(metadata.path, setup);
assert.equal(metadata.sha512, hash(blobs.get(setup), "sha512", "base64"));
const installer = metadata.files.find((file) => file.url === setup);
assert.equal(installer.size, blobs.get(setup).length);
assert.equal(installer.sha512, metadata.sha512);
const checksumName = `SHA256SUMS-${version}.txt`;
await writeFile(join(output, checksumName), names.map((name) => `${hash(blobs.get(name))}  ${name}`).join("\n") + "\n");
console.log(`PASS: v${version}, ${sources.length} packaged source/assets byte-identical, ${natives.length} native PTY files unpacked, no private root artifacts, update SHA-512/size correct.`);
for (const name of names) console.log(`${name}: ${blobs.get(name).length} bytes`);
console.log(`Generated ${checksumName}`);

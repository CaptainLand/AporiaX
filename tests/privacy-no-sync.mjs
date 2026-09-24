import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { extractFile, listPackage } from "@electron/asar";
import { cleanupLegacyMobileData, LEGACY_MOBILE_CACHE_FILES } from "../electron/account/legacy-mobile-cleanup.js";

const removedFiles = [
  "electron/account/remote-file-broker.js", "electron/account/remote-command-inbox.js",
  "src/account/remote-sync.js",
];
const forbidden = /\/remote\/(?:desktop|mobile)|account:(?:sync-tasks|remote-commands|set-remote-enabled|set-remote-file-access|claim-remote-command|ack-remote-command|execute-remote-file-command)|buildRemoteTaskSyncPayload|uploadRemoteCommandFile|createRemoteCommandInbox|MOBILE_COMPANION_ENABLED|remoteServiceSupported/;
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (/\.(?:cjs|mjs|js|jsx)$/.test(entry.name)) assert.doesNotMatch(await readFile(file, "utf8"), forbidden, file);
  }
}
for (const file of removedFiles) await assert.rejects(access(file), { code: "ENOENT" });
for (const directory of ["electron", "src", "shared"]) await scan(directory);
const preload = await readFile("electron/preload.cjs", "utf8");
const accountBridge = preload.slice(preload.indexOf("  account: {"), preload.indexOf("  tasks: {"));
const methods = [...accountBridge.matchAll(/^\s+(\w+):/gm)].map(match => match[1]);
assert.deepEqual(methods, ["account", "get", "signIn", "openCenter", "refresh", "signOut"]);

const temp = await mkdtemp(join(tmpdir(), "aporia-privacy-cleanup-"));
try {
  for (const name of LEGACY_MOBILE_CACHE_FILES) await writeFile(join(temp, name), "private fixture - never read");
  for (const name of ["aporiax-tasks.json", "aporiax-account-session.json", "user-project.txt"]) await writeFile(join(temp, name), "keep");
  const result = await cleanupLegacyMobileData(temp);
  assert.deepEqual(result.failed, []);
  assert.equal(result.removed.length, LEGACY_MOBILE_CACHE_FILES.length);
  for (const name of ["aporiax-tasks.json", "aporiax-account-session.json", "user-project.txt"]) assert.equal(await readFile(join(temp, name), "utf8"), "keep");
  assert.equal((await cleanupLegacyMobileData(temp)).removed.length, 0, "Cleanup is idempotent");
  // A directory with a legacy filename is not recursively deleted.
  const directory = join(temp, LEGACY_MOBILE_CACHE_FILES[0]);
  await mkdir(directory);
  await writeFile(join(directory, "keep.txt"), "keep");
  assert.deepEqual((await cleanupLegacyMobileData(temp)).failed, [LEGACY_MOBILE_CACHE_FILES[0]]);
  assert.equal(await readFile(join(directory, "keep.txt"), "utf8"), "keep");
} finally { await rm(temp, { recursive: true, force: true }); }

const asarIndex = process.argv.indexOf("--asar");
if (asarIndex !== -1) {
  const archive = process.argv[asarIndex + 1];
  assert(archive, "--asar requires a path");
  for (const file of listPackage(archive)) {
    const relative = file.replaceAll("\\", "/").replace(/^\//, "");
    assert(!removedFiles.includes(relative), relative);
    if (/^(?:electron|dist|shared)\/.*\.(?:js|cjs|mjs)$/.test(relative))
      assert.doesNotMatch(extractFile(archive, normalize(relative)).toString("utf8"), forbidden, relative);
    assert(!relative.startsWith("aporiax-mobile/"), "Retired prototype must never ship");
  }
  console.log("PASS: packaged ASAR has no companion upload/control implementation");
}
console.log("PASS: no sync source or IPC; only exact legacy caches removed; local history and credentials preserved");

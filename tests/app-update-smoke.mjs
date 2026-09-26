import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import {
  AUTO_CHECK_INTERVAL_MS,
  LATEST_YML_URL,
  RELEASES_URL,
  compareVersions,
  createUpdateStatus,
  installUpdateDecision,
  isNewerVersion,
  isPortableBuild,
  parseLatestYml,
  shouldSkipAutoCheck,
  updateChannel,
} from "../electron/app-update-core.js";

assert.equal(compareVersions("0.8.4", "0.8.4"), 0);
assert.equal(compareVersions("0.8.5", "0.8.4"), 1);
assert.equal(compareVersions("0.8.3", "0.8.4"), -1);
assert.equal(compareVersions("v0.9.0", "0.8.4"), 1);
assert.equal(isNewerVersion("0.8.5", "0.8.4"), true);
assert.equal(isNewerVersion("0.8.4", "0.8.4"), false);
assert.equal(isNewerVersion("0.8.3", "0.8.4"), false);
assert.equal(isNewerVersion("1.0.0-preview", "0.9.9"), true);
assert.equal(isNewerVersion("1.0.0-preview", "1.0.0-preview"), false);
assert.equal(isNewerVersion("1.0.0-preview.3", "1.0.0-preview"), true);
assert.equal(isNewerVersion("1.0.0-preview.3", "1.0.0-preview.2"), true);
assert.equal(isNewerVersion("1.0.0-preview.3", "1.0.0-preview.2.beta.1"), true);
assert.equal(isNewerVersion("1.0.0", "1.0.0-preview.3"), true);
assert.equal(isNewerVersion("1.0.0-preview.3", "1.0.0"), false);
assert.equal(compareVersions("1.0.0+build.4", "1.0.0+build.5"), 0);
assert.equal(compareVersions("1.0.0-preview.10", "1.0.0-preview.3"), 1);
assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-preview.7"), 1);
assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.1"), 1);
assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
assert.equal(isNewerVersion("1.0.0-preview.7", "1.0.0-rc.1"), false);
assert.equal(isNewerVersion("1.0.0-rc.1", "1.0.0"), false);
assert.throws(() => compareVersions("invalid", "1.0.0-preview.3"), /INVALID_UPDATE_VERSION/);

assert.equal(isPortableBuild({}), false);
assert.equal(isPortableBuild({ PORTABLE_EXECUTABLE_FILE: "D:\\AporiaX.exe" }), true);
assert.equal(isPortableBuild({ PORTABLE_EXECUTABLE_DIR: "D:\\AporiaX" }), true);

assert.equal(updateChannel({ packaged: false, portable: false }), "dev");
assert.equal(updateChannel({ packaged: true, portable: true }), "portable");
assert.equal(updateChannel({ packaged: true, portable: false }), "nsis");

const parsed = parseLatestYml(`version: 0.8.5
files:
  - url: AporiaX-Setup-0.8.5-x64.exe
    sha512: abc
    size: 1
path: AporiaX-Setup-0.8.5-x64.exe
`);
assert.equal(parsed.version, "0.8.5");
assert.equal(parsed.path, "AporiaX-Setup-0.8.5-x64.exe");
assert.deepEqual(parseLatestYml(""), { version: "", path: "" });
assert.deepEqual(
  parseLatestYml("version: 1.0.0-preview\npath: AporiaX-Setup-1.0.0-preview-x64.exe\n"),
  { version: "1.0.0-preview", path: "AporiaX-Setup-1.0.0-preview-x64.exe" },
);

assert.equal(shouldSkipAutoCheck(0, 1_000), false);
assert.equal(shouldSkipAutoCheck(1_000, 1_000 + AUTO_CHECK_INTERVAL_MS - 1), true);
assert.equal(shouldSkipAutoCheck(1_000, 1_000 + AUTO_CHECK_INTERVAL_MS), false);

assert.deepEqual(
  installUpdateDecision({ channel: "nsis", downloaded: true, activeRuns: 0 }),
  { ok: true },
);
assert.equal(
  installUpdateDecision({ channel: "nsis", downloaded: true, activeRuns: 2 }).code,
  "TASK_RUNNING",
);
assert.equal(
  installUpdateDecision({ channel: "portable", downloaded: true, activeRuns: 0 }).code,
  "UNSUPPORTED_CHANNEL",
);
assert.equal(
  installUpdateDecision({ channel: "nsis", downloaded: false, activeRuns: 0 }).code,
  "NOT_DOWNLOADED",
);

const idle = createUpdateStatus({ phase: "idle", currentVersion: "0.8.4", channel: "nsis" });
assert.equal(idle.busy, false);
assert.equal(createUpdateStatus({ phase: "checking" }).busy, true);
assert.equal(createUpdateStatus({ phase: "downloading", downloadPercent: 140 }).downloadPercent, 100);
assert.match(LATEST_YML_URL, /latest\/download\/latest\.yml$/);
assert.match(RELEASES_URL, /CaptainLand\/AporiaX\/releases$/);

const updater = await readFile(new URL("../electron/app-update.js", import.meta.url), "utf8");
const mainV2 = await readFile(new URL("../electron/main-v2.js", import.meta.url), "utf8");
const preload = await readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8");
const about = await readFile(new URL("../src/settings/AppUpdateControls.jsx", import.meta.url), "utf8");
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

assert.match(updater, /import electronUpdater from "electron-updater"/);
assert.match(updater, /autoDownload = false/);
assert.match(updater, /autoInstallOnAppQuit = false/);
assert.match(updater, /quitAndInstall\(false, true\)/);
assert.match(mainV2, /installAppUpdate\(/);
// The kernel is the authoritative source, including paused and starting tasks.
// Exercise the real wiring rather than matching the removed tray snapshot API.
const updateWiring = mainV2.match(/installAppUpdate\(\{[\s\S]*?\}\);/)?.[0];
assert(updateWiring, "Missing updater wiring");
for (const states of [null, [], ["running"], ["paused"], ["starting"], ["running", "paused"]]) {
  let options;
  const kernel = states === null ? null : { taskRuntime: { listActiveRuns: () => states.map((status) => ({ status })) } };
  runInNewContext(updateWiring, { kernel, installAppUpdate: (value) => { options = value; } });
  const count = options.getActiveRunCount();
  assert.equal(count, states?.length || 0);
  const decision = installUpdateDecision({ channel: "nsis", downloaded: true, activeRuns: count });
  assert.equal(decision.ok, count === 0);
  if (count > 0) assert.equal(decision.code, "TASK_RUNNING");
}
assert.match(preload, /update:status/);
assert.match(preload, /update:install/);
assert.match(about, /检查更新/);
assert.match(about, /重启安装/);
assert.equal(pkg.build.publish.provider, "github");
assert.equal(pkg.build.publish.owner, "CaptainLand");
assert.equal(pkg.dependencies["electron-updater"] != null, true);

console.log("app update smoke: PASS");

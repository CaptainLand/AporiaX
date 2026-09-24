import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import * as core from "../electron/app-update-core.js";
const source = (await readFile("electron/app-update.js", "utf8")).replace(/import[\s\S]*?from\s+"[^"]+";/g, "").replace("export function", "function");
function fixture({ portable = true, fail = false } = {}) {
  const events = [], urls = [], opened = [], feeds = [];
  let now = 100_000, active = 0, remote = "1.0.0-preview.4", failure = fail;
  const updater = new EventEmitter();
  updater.setFeedURL = value => feeds.push(value);
  updater.checkForUpdates = async () => { updater.emit("update-available", { version: remote }); return { updateInfo: { version: remote } }; };
  updater.downloadUpdate = async () => { updater.emit("download-progress", { percent: 52 }); updater.emit("update-downloaded", { version: remote }); };
  updater.quitAndInstall = () => { opened.push("install"); };
  const create = runInNewContext(source + "\ninstallAppUpdate", {
    ...core, URL, AbortSignal, Date: class extends Date { static now() { return now; } },
    app: { isPackaged: true, getVersion: () => "1.0.0-preview.3" },
    process: { env: { APORIAX_FRIENDS_BETA: "1", ...(portable ? { PORTABLE_EXECUTABLE_FILE: "fixture.exe" } : {}) } },
    loadCloudEndpoints: () => ({ configured: true, accountWebUrl: "https://cloud.example.invalid" }),
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_name, value) => events.push(value) } }] },
    electronUpdater: { autoUpdater: updater }, ipcMain: {}, handleTrustedIpc: () => {},
    shell: { openExternal: async url => opened.push(url) },
    fetch: async (url, options) => {
      urls.push(url); assert.ok(options.signal); assert.equal(options.cache, "no-store");
      await new Promise(resolve => setTimeout(resolve, 5));
      if (failure === true || failure === "github" && url.includes("github.com")) throw Error("offline");
      return new Response("version: " + remote + "\npath: AporiaX-Setup-" + remote + "-x64.exe\n");
    },
  });
  return { runtime: create({ getActiveRunCount: () => active }), events, urls, opened, feeds, updater,
    advance: ms => now += ms, fail: value => failure = value, remote: value => remote = value, active: value => active = value };
}
for (const [a,b,want] of [["1.0.0","1.0.0-preview.4",1],["1.0.0-preview.10","1.0.0-preview.4",1],["1.0.0-preview.4","1.0.0-preview.3",1],["1.0.0-preview.4+build","1.0.0-preview.4",0]]) assert.equal(core.compareVersions(a,b),want);
assert.throws(() => core.compareVersions("nonsense","1.0.0"));
const f = fixture();
await Promise.all([f.runtime.check(), f.runtime.check(), f.runtime.check({force:true})]);
assert.equal(f.urls.length,1); assert.equal(f.runtime.snapshot().phase,"available");
await f.runtime.check(); assert.equal(f.urls.length,1);
const secondLaunch = fixture(); await secondLaunch.runtime.check(); assert.equal(secondLaunch.urls.length,1);
f.advance(core.AUTO_CHECK_INTERVAL_MS); f.fail(true); await f.runtime.check();
assert.equal(f.runtime.snapshot().phase,"error"); assert.equal(f.runtime.snapshot().availableVersion,"1.0.0-preview.4");
const attempts = f.urls.length; await f.runtime.check(); assert.equal(f.urls.length,attempts);
f.advance(60000); f.fail("github"); await f.runtime.check(); assert.equal(f.runtime.snapshot().phase,"available");
assert.match(f.urls.at(-1), /cloud.example.invalid\/downloads\/latest.yml/);
await f.runtime.download(); assert.equal(f.opened.at(-1),core.LATEST_RELEASE_URL);
const n = fixture({ portable:false, fail:"github" }); await n.runtime.check();
assert.equal(n.feeds.at(-1).channel,"latest"); assert.match(n.feeds.at(-1).url,/cloud.example.invalid/);
assert.equal(n.updater.allowPrerelease,true); assert.equal(n.updater.autoDownload,false);
await n.runtime.download(); assert.equal(n.runtime.snapshot().phase,"downloaded");
const before = n.urls.length; await n.runtime.check({force:true}); assert.equal(n.urls.length,before);
n.active(1); await n.runtime.install(); assert.equal(n.runtime.snapshot().error,"TASK_RUNNING"); assert.equal(n.opened.length,0);
n.active(0); await n.runtime.install(); assert.deepEqual(n.opened,["install"]);
console.log("PASS update runtime: SemVer, every launch, concurrent coalescing, bounded offline retry, trusted mirror, beta, latest channel, task-safe install");

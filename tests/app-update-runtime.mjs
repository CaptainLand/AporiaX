import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import * as core from "../electron/app-update-core.js";
const source = (await readFile("electron/app-update.js", "utf8")).replace(/import[\s\S]*?from\s+"[^"]+";/g, "").replace("export function", "function");
function fixture({ portable = true, fail = false, downloadFail = '', mirrorMismatch = false, updaterMismatch = false } = {}) {
  const events = [], urls = [], opened = [], feeds = [];
  let now = 100_000, active = 0, remote = "1.0.0-preview.4", failure = fail;
  const updater = new EventEmitter();
  updater.setFeedURL = value => feeds.push(value);
  const hash = 'a'.repeat(86) + '==', downloads = [];
  updater.checkForUpdates = async () => { updater.emit("update-available", { version: remote }); return { updateInfo: { version: remote,
    files: [{ url: `AporiaX-Setup-${remote}-x64.exe`, sha512: updaterMismatch ? 'b'.repeat(86)+'==' : hash, size: 12345 }] } }; };
  updater.downloadUpdate = async () => {
    downloads.push(feeds.at(-1).url);
    await new Promise(resolve => setTimeout(resolve, 5));
    if (downloadFail && (downloads.length === 1 || downloadFail === 'both')) {
      const error = new Error(downloadFail === 'both' ? 'ECONNRESET' : downloadFail); updater.emit('error', error); throw error;
    }
    updater.emit("download-progress", { percent: 52 }); updater.emit("update-downloaded", { version: remote });
  };
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
      const digest = mirrorMismatch && url.includes('cloud.example.invalid') ? 'b'.repeat(86)+'==' : hash;
      return new Response(`version: ${remote}\nfiles:\n  - url: AporiaX-Setup-${remote}-x64.exe\n    sha512: ${digest}\n    size: 12345\npath: AporiaX-Setup-${remote}-x64.exe\nsha512: ${digest}\n`);
    },
  });
  return { runtime: create({ getActiveRunCount: () => active }), events, urls, opened, feeds, updater, downloads,
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
const fallback = fixture({portable:false,downloadFail:'ECONNRESET'}); await fallback.runtime.check();
await Promise.all([fallback.runtime.download(),fallback.runtime.download()]);
assert.equal(fallback.downloads.length,2); assert.match(fallback.downloads[1],/cloud.example.invalid/);
assert.equal(fallback.runtime.snapshot().phase,'downloaded'); assert.equal(fallback.runtime.snapshot().downloadSource,'mirror');
assert.equal(fallback.events.filter(e=>e.phase==='error').length,0);
for (const args of [{downloadFail:'sha512 checksum mismatch'}, {downloadFail:'certificate invalid'}, {downloadFail:'ECONNRESET',mirrorMismatch:true}]) {
  const broken=fixture({portable:false,...args}); await broken.runtime.check(); await broken.runtime.download();
  assert.equal(broken.downloads.length,1); assert.equal(broken.runtime.snapshot().phase,'error');
}
const mismatch=fixture({portable:false,updaterMismatch:true}); await mismatch.runtime.check(); await mismatch.runtime.download();
assert.equal(mismatch.runtime.snapshot().phase,'error'); assert.equal(mismatch.downloads.length,0);
const both=fixture({portable:false,downloadFail:'both'}); await both.runtime.check(); await both.runtime.download();
assert.equal(both.downloads.length,2); assert.equal(both.runtime.snapshot().phase,'error');
const portableMirror=fixture(); await portableMirror.runtime.check(); await portableMirror.runtime.openRelease({source:'mirror'});
assert.equal(portableMirror.opened[0],'https://cloud.example.invalid/downloads/AporiaX-Portable-1.0.0-preview.4-x64.exe');
await portableMirror.runtime.openRelease({source:'https://evil.invalid'}); assert.equal(portableMirror.opened.length,1);
assert.equal(core.sameUpdateAsset({version:'1',path:'x'},{version:'1',path:'x'}),false);
assert.equal(core.sameUpdateAsset({version:'1',path:'x',sha512:'a'.repeat(86)+'==',size:1},{version:'2',path:'x',sha512:'a'.repeat(86)+'==',size:1}),false);
assert.equal(core.sameUpdateAsset({version:'1',path:'x',sha512:'a'.repeat(86)+'==',size:1},{version:'1',path:'x',sha512:'a'.repeat(86)+'==',size:2}),false);
console.log("PASS update runtime: SemVer, every launch, concurrent coalescing, bounded offline retry, trusted mirror, beta, latest channel, task-safe install");
console.log('PASS download fallback: coalesced retry, same asset only, checksum/certificate rejection, failed sources, metadata race, portable mirror, IPC source allowlist');

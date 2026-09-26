import assert from "node:assert/strict";
import { _electron } from "playwright-core";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const output = resolve(process.argv[2] || "release");
const evidence = resolve(".tmp", "packaged-" + version);
await mkdir(evidence, { recursive: true });
for (const portable of [false, true]) {
  const directory = await mkdtemp(join(evidence, "profile-"));
  const env = { ...process.env, APPDATA: directory, LOCALAPPDATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PORTABLE_EXECUTABLE_FILE; delete env.PORTABLE_EXECUTABLE_DIR;
  for (const key of ["APORIAX_ACCOUNT_WEB_URL", "APORIAX_CLOUD_API_URL", "APORIAX_MODEL_GATEWAY_URL", "NODE_OPTIONS", "DEEPSEEK_API_KEY"]) delete env[key];
  if (portable) { env.PORTABLE_EXECUTABLE_FILE = join(output, `AporiaX-Portable-${version}-x64.exe`); env.PORTABLE_EXECUTABLE_DIR = output; }
  const app = await _electron.launch({ executablePath: join(output, "win-unpacked/AporiaX.exe"), args: ["--user-data-dir=" + directory, "--disable-gpu"], env, timeout: 30000 });
  try {
    const info = await app.evaluate(({ app, shell }) => {
      globalThis.openedUrls = [];
      shell.openExternal = async url => { globalThis.openedUrls.push(url); };
      return { version: app.getVersion(), packaged: app.isPackaged, profile: app.getPath("userData") };
    });
    assert.equal(info.version, version); assert.equal(info.packaged, true);
    assert.ok(info.profile.replaceAll("\\", "/").startsWith(directory.replaceAll("\\", "/")), "must use empty isolated profile");
    const page = await app.firstWindow(), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.waitForFunction(() => Boolean(window.desktop?.update));
    let status;
    for (let i = 0; i < 180; i++) {
      status = await page.evaluate(() => window.desktop.update.status());
      if (["not-available", "available", "error"].includes(status.phase)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(status.phase, "not-available", JSON.stringify(status));
    assert.equal(status.channel, portable ? "portable" : "nsis");
    if (await page.locator(".ax-welcome__enter").isVisible()) await page.locator(".ax-welcome__enter").click();
    assert.equal(await page.locator(".app-update-sidebar").count(), 0);
    await page.locator(".local-account-signin").click();
    await app.waitForEvent("window", { timeout: 100 }).catch(() => {});
    for (let i = 0; i < 30; i++) { if ((await app.evaluate(() => globalThis.openedUrls)).length) break; await new Promise(r => setTimeout(r, 100)); }
    const urls = await app.evaluate(() => globalThis.openedUrls);
    assert.ok(urls.length > 0);
    const login = new URL(urls[0]);
    assert.equal(login.origin, "https://101.43.44.160"); assert.equal(login.searchParams.get("app_version"), version);
    assert.equal(login.searchParams.get("code_challenge_method"), "S256");
    await page.screenshot({ path: join(directory, "app.png") });
    assert.deepEqual(errors, []);
    console.log("PASS actual packaged " + (portable ? "portable mode" : "installer mode") + ": empty profile, startup update, no-update hidden, production PKCE URL, zero page errors");
  } finally { await app.close(); }
}

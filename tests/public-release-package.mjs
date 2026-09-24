import assert from "node:assert/strict";
import { _electron } from "playwright-core";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractFile, listPackage } from "@electron/asar";

// Anonymous/read-only release QA: no production fixture account, OTP or inference.
const older = process.argv.includes("--check-older");
const output = resolve(process.argv[2] || "release/v1.0.0-preview.4");
const archive = join(output, "win-unpacked/resources/app.asar");
const pkg = JSON.parse(extractFile(archive, "package.json"));
const targetVersion = "1.0.0-preview.4";
if (!older) {
  assert.equal(pkg.version, targetVersion);
  assert.equal(pkg.main, "electron/main-v2.js");
  assert.deepEqual(JSON.parse(extractFile(archive, "config/cloud-endpoints.json")), {
    version: 1, accountWebUrl: "https://101.43.44.160",
    accountApiUrl: "https://101.43.44.160/api", modelGatewayUrl: "https://101.43.44.160/gateway",
  });
  assert.ok(!listPackage(archive).some(p => /cloud-private-preview\.json|\.ssh[\\/]|\.env($|\.)|aporiax-account-session\.json/i.test(p)));
}
await mkdir(".tmp", { recursive: true });
for (const portable of [false, true]) {
  const profile = await mkdtemp(resolve(".tmp/public-release-qa-"));
  const data = join(profile, "data");
  await mkdir(data);
  // A stale profile from the private test must not redirect the public package.
  if (!older) await writeFile(join(data, "cloud-private-preview.json"), "invalid old private profile");
  const env = { ...process.env, APPDATA: join(profile, "roaming"), LOCALAPPDATA: join(profile, "local") };
  for (const key of Object.keys(env)) if (/^(APORIAX_|ELECTRON_RUN_AS_NODE|PORTABLE_EXECUTABLE)/.test(key)) delete env[key];
  if (portable) env.PORTABLE_EXECUTABLE_FILE = join(output, "portable-test.exe");
  const desktop = await _electron.launch({ executablePath: join(output, "win-unpacked/AporiaX.exe"), args: ["--user-data-dir=" + data], env, timeout: 45000 });
  try {
    const info = await desktop.evaluate(({ app, shell }) => {
      shell.openExternal = async url => { globalThis.__releaseOpenedUrl = url; };
      return { packaged: app.isPackaged, version: app.getVersion(), data: app.getPath("userData"), beta: process.env.APORIAX_FRIENDS_BETA };
    });
    assert.equal(info.packaged, true);
    assert.equal(info.data, data);
    assert.equal(info.beta, undefined);
    assert.equal(info.version, pkg.version);
    const page = await desktop.firstWindow();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.locator(".ax-welcome__enter").click({ timeout: 45000 });
    if (!older) {
      await page.locator(".local-account-signin").click();
      let authUrl;
      for (let i = 0; i < 60; i++) {
        authUrl = await desktop.evaluate(() => globalThis.__releaseOpenedUrl);
        if (authUrl) break;
        await new Promise(r => setTimeout(r, 250));
      }
      const auth = new URL(authUrl);
      assert.equal(auth.origin, "https://101.43.44.160");
      assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
      assert.equal(auth.searchParams.get("app_version"), targetVersion);
      assert.equal(new URL(auth.searchParams.get("redirect_uri")).hostname, "127.0.0.1");
      await page.evaluate(() => window.desktop.account.openCenter());
      assert.equal(await desktop.evaluate(() => globalThis.__releaseOpenedUrl), "https://101.43.44.160/account");
      console.log("PASS packaged public sign-in + PKCE + account center; stale SSH profile ignored; " + (portable ? "portable" : "installer"));
    }
    let update;
    for (let i = 0; i < 90; i++) {
      update = await page.evaluate(() => window.desktop.update.status());
      if (!update.busy) break;
      await new Promise(r => setTimeout(r, 500));
    }
    update = await page.evaluate(() => window.desktop.update.check({ force: true }));
    assert.equal(update.channel, portable ? "portable" : "nsis");
    assert.notEqual(update.phase, "error", update.error);
    if (older) {
      assert.equal(update.phase, "available");
      assert.equal(update.availableVersion, targetVersion);
    } else {
      assert.equal(update.phase, "not-available");
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(profile, "desktop.png") });
    console.log("PASS actual packaged updater: " + JSON.stringify({ current: pkg.version, channel: update.channel, phase: update.phase, available: update.availableVersion }));
  } finally {
    await desktop.close();
  }
}

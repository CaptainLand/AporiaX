import assert from "node:assert/strict";
import { _electron, chromium } from "playwright-core";
import { mkdtemp, mkdir, copyFile, readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { listPackage } from "@electron/asar";
import { createServer } from "node:net";
import { measureTextContrast } from "./text-contrast.js";

const output = resolve(process.argv[2] || "release/v1.0.0-preview.2-oneclick");
const resources = join(output, "win-unpacked/resources");
const webSource = resolve(".tmp/aporiax-web-guide/.tmp/private-preview-web");
async function files(root) { const result = []; for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); result.push(...entry.isDirectory() ? await files(path) : [path]); } return result; }
const sourceFiles = await files(webSource);
const packagedFiles = await files(join(resources, "private-cloud-web"));
const hash = data => createHash("sha256").update(data).digest("hex");
assert.equal(packagedFiles.length, sourceFiles.length);
for (const file of sourceFiles) assert.equal(hash(await readFile(file)), hash(await readFile(join(resources, "private-cloud-web", relative(webSource, file)))));
const entries = [...listPackage(join(resources, "app.asar")), ...packagedFiles];
assert.ok(!entries.some(path => /cloud-private-preview\.json|cloud-private-known-hosts|\.ssh[\\/]|\.env($|[.])|id_ed25519|cloud_preview_ed25519/i.test(path)), "Package must not include machine configuration or keys");
const profile = await mkdtemp(resolve(".tmp/private-packaged-"));
const data = join(profile, "data"); await mkdir(data);
await copyFile(join(homedir(), "AppData/Roaming/AporiaX/cloud-private-preview.json"), join(data, "cloud-private-preview.json"));
const sshArgs = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-i", join(homedir(), ".ssh/aporiax_cloud_preview_ed25519"), "ubuntu@101.43.44.160"];
const command = "cd /srv/aporiax-cloud-preview && sudo -n bash deploy/private-preview/compose.sh exec -T api node -";
const fixtureInput = " < scripts/private-preview-browser-fixture.cjs";
let fixture, desktop, browser;
try {
  fixture = JSON.parse(execFileSync("ssh", [...sshArgs, command + fixtureInput], { encoding: "utf8", timeout: 15000, windowsHide: true }));
  const env = { ...process.env, APPDATA: join(profile, "roaming"), LOCALAPPDATA: join(profile, "local") };
  for (const key of ["ELECTRON_RUN_AS_NODE", "APORIAX_ACCOUNT_WEB_URL", "APORIAX_CLOUD_API_URL", "APORIAX_MODEL_GATEWAY_URL"]) delete env[key];
  desktop = await _electron.launch({ executablePath: join(output, "win-unpacked/AporiaX.exe"), args: [`--user-data-dir=${data}`], env, timeout: 30000 });
  const info = await desktop.evaluate(({ app, shell }) => {
    shell.openExternal = async url => { globalThis.__privateAuthUrl = url; };
    return { userData: app.getPath("userData"), packaged: app.isPackaged, version: app.getVersion() };
  });
  assert.equal(info.packaged, true); assert.equal(info.version, "1.0.0-preview.2"); assert.equal(info.userData, data);
  const page = await desktop.firstWindow();
  await page.locator('.ax-welcome__enter').click({ timeout: 30000 });
  await page.locator(".local-account-signin").click({ timeout: 30000 });
  let url;
  for (let i = 0; i < 60; i++) { url = await desktop.evaluate(() => globalThis.__privateAuthUrl); if (url) break; await new Promise(done => setTimeout(done, 500)); }
  assert.ok(url, "Clicking sign-in must open the browser automatically"); assert.equal(new URL(url).origin, "http://localhost:15173");
  browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const context = await browser.newContext();
  await context.addCookies([{ name: "aporia_refresh", value: fixture.refresh, domain: "localhost", path: "/auth", httpOnly: true, secure: true, sameSite: "Lax" }]);
  const web = await context.newPage(); await web.addInitScript(() => localStorage.setItem("aporia-language", "zh"));
  await web.goto(url);
  await web.locator('.desktop-auth-account strong').waitFor();
  assert.ok((await web.locator('.desktop-auth-account strong').evaluate(measureTextContrast)).ratio >= 4.5);
  await web.getByRole("button", { name: "确认并连接", exact: true }).click({ timeout: 20000 });
  await page.locator(".local-account-profile").waitFor({ timeout: 20000 });
  const snapshot = await page.evaluate(async () => { const a = await window.desktop.account.get(); return { status: a.status, gateway: a.gatewayStatus }; });
  assert.deepEqual(snapshot, { status: "authenticated", gateway: "verified" });
  const center = page.locator('.local-account-web');
  if (!await center.isVisible()) await page.locator('.local-account-profile').click();
  await center.click();
  let centerUrl;
  for (let i = 0; i < 40; i++) { centerUrl = await desktop.evaluate(() => globalThis.__privateAuthUrl); if (centerUrl === 'http://localhost:15173/account') break; await new Promise(done => setTimeout(done, 250)); }
  assert.equal(centerUrl, 'http://localhost:15173/account', 'Account center must use the same active Web with no credentials in the URL');
  await web.goto(centerUrl); await web.locator('.account-sidebar').waitFor({ timeout: 20000 });
  const anonymous = await browser.newContext(); const anonymousPage = await anonymous.newPage();
  await anonymousPage.goto(centerUrl); await anonymousPage.locator('.account-gate').waitFor();
  assert.equal(await anonymousPage.locator('.account-sidebar').count(), 0, 'Opening the route must not bypass Web authentication');
  await anonymous.close();
  await page.screenshot({ path: join(profile, "signed-in.png") });
  await page.evaluate(() => window.desktop.account.signOut());
  await desktop.close(); desktop = null;
  await browser.close(); browser = null;
  for (const port of [14100, 14200, 15173]) await new Promise((done, reject) => { const s = createServer(); s.once("error", reject); s.listen(port, "127.0.0.1", () => s.close(done)); });
  console.log(`PASS: packaged v${info.version}, latest Web ${sourceFiles.length} files match, no private keys/config in package; sign-in -> automatic SSH/Web -> authorization -> Cloud -> desktop -> account center; anonymous Web access still gated, readable authorization details, exit released all preview ports.`);
  console.log(`QA screenshot: ${join(profile, "signed-in.png")}`);
} finally {
  await desktop?.close(); await browser?.close();
  if (fixture) execFileSync("ssh", [...sshArgs, command + " cleanup " + fixture.user + fixtureInput], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, timeout: 15000 });
}

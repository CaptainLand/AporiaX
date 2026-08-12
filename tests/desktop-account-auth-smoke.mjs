import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  APORIAX_DESKTOP_CLIENT_ID,
  buildDesktopAuthorizationUrl,
  createDesktopPkce,
  parseDesktopLoopbackCallback,
  projectAccountSnapshot,
} from "../electron/account/desktop-account-core.js";

const pkce = createDesktopPkce();
assert.equal(pkce.codeVerifier.length, 43);
assert.equal(pkce.codeChallenge.length, 43);
assert.match(pkce.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
assert.match(pkce.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
assert.match(pkce.state, /^[A-Za-z0-9_-]{32}$/);

const redirectUri = "http://127.0.0.1:49152/callback";
const authorizationUrl = new URL(buildDesktopAuthorizationUrl({
  webBaseUrl: "https://captainland.github.io/AporiaX_web/",
  redirectUri,
  codeChallenge: pkce.codeChallenge,
  state: pkce.state,
  deviceName: "CI Windows PC",
  platform: "win32",
  appVersion: "0.6.5",
}));
assert.equal(authorizationUrl.pathname, "/AporiaX_web/authorize/desktop");
assert.equal(authorizationUrl.searchParams.get("client_id"), APORIAX_DESKTOP_CLIENT_ID);
assert.equal(authorizationUrl.searchParams.get("redirect_uri"), redirectUri);
assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
assert.equal(authorizationUrl.searchParams.get("state"), pkce.state);

const callback = parseDesktopLoopbackCallback(
  `${redirectUri}?code=${"a".repeat(43)}&state=${pkce.state}`,
  { redirectUri, state: pkce.state },
);
assert.equal(callback.canceled, false);
assert.equal(callback.code, "a".repeat(43));

const canceled = parseDesktopLoopbackCallback(
  `${redirectUri}?error=access_denied&state=${pkce.state}`,
  { redirectUri, state: pkce.state },
);
assert.equal(canceled.canceled, true);

assert.throws(
  () => parseDesktopLoopbackCallback(
    `${redirectUri}?code=${"a".repeat(43)}&state=wrong-state-value`,
    { redirectUri, state: pkce.state },
  ),
  /DESKTOP_STATE_MISMATCH/,
);

const snapshot = projectAccountSnapshot({
  me: {
    user: { id: "user-1", displayName: "Lan" },
    identities: [{ type: "email", identifier: "lan@example.com" }],
    session: { id: "session-1", deviceId: "device-1" },
  },
  quota: { remainingRatio: 0.82 },
  models: [{ slug: "aporia-cloud-default", displayName: "DeepSeek V4 Flash" }],
  usage: { requestCount: 3 },
  devices: [{ id: "device-1", name: "CI Windows PC", type: "desktop" }],
});
assert.equal(snapshot.status, "authenticated");
assert.equal(snapshot.profile.email, "lan@example.com");
assert.equal(snapshot.device.name, "CI Windows PC");
assert.equal(snapshot.models[0].displayName, "DeepSeek V4 Flash");

for (const file of [
  "electron/account/desktop-account-runtime.js",
  "electron/account/register-desktop-account-ipc.js",
  "electron/account/desktop-account-core.js",
]) {
  const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(checked.status, 0, `${file} syntax check failed: ${checked.stderr}`);
}

const runtime = await readFile("electron/account/desktop-account-runtime.js", "utf8");
assert.match(runtime, /aporiax-installation\.json/);
assert.match(runtime, /randomUUID\(\)/);
assert.match(runtime, /installationId,/);
assert.match(runtime, /Installation identity deliberately survives sign-out/);
assert.doesNotMatch(runtime, /machineGuid|wmic|MAC address|serialnumber/i);

const preload = await readFile("electron/preload.cjs", "utf8");
assert.match(preload, /account:\s*\{/);
assert.match(preload, /account:sign-in/);
assert.doesNotMatch(preload, /accessToken|refreshToken/);

const accountPanel = await readFile("src/account/LocalAccountPanel.jsx", "utf8");
assert.match(accountPanel, /window\.desktop\?\.account/);
assert.match(accountPanel, /Continue in browser/);
assert.match(accountPanel, /Aporia Cloud 未连接/);
assert.doesNotMatch(accountPanel, /local-account-inline-error--panel/);
assert.doesNotMatch(accountPanel, /landx|111111|Local UI prototype/);

console.log("desktop account auth smoke: PASS");

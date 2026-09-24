import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { request } from "node:http";
import { generateKeyPairSync, createHash } from "node:crypto";
import { validatePrivateProfile, readPrivateProfile, privateSessionIdentity, privateSshArgs, startPrivateWeb, createPrivateCloudBridge, privateCloudOptions } from "../electron/account/private-cloud-bridge.js";
import { loadCloudEndpoints } from "../electron/account/cloud-endpoints.js";
import { accountErrorText } from "../src/account/account-errors.js";

const root = await mkdtemp(join(tmpdir(), "aporia-bridge-test-"));
const { publicKey } = generateKeyPairSync("ed25519");
const prefix = Buffer.from("0000000b7373682d6564323535313900000020", "hex");
const key = Buffer.concat([prefix, publicKey.export({ type: "spki", format: "der" }).subarray(-32)]);
const profile = { version: 1, host: "example.com", user: "ubuntu", identityFile: join(root, "key"), hostKey: `ssh-ed25519 ${key.toString("base64")}`, fingerprint: `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}` };
const resources = [];
try {
  assert.deepEqual(validatePrivateProfile(profile), profile);
  for (const mutation of [{ host: "-oProxyCommand=x" }, { user: "root;echo" }, { identityFile: "relative" }, { fingerprint: "SHA256:wrong" }, { hostKey: "ssh-ed25519 AAAA" }]) assert.throws(() => validatePrivateProfile({ ...profile, ...mutation }), /CONFIG_INVALID/);
  assert.equal(readPrivateProfile(join(root, "missing")), null);
  await writeFile(join(root, "invalid"), "not-json");
  assert.throws(() => readPrivateProfile(join(root, "invalid")), /CONFIG_INVALID/);
  assert.deepEqual(privateCloudOptions({ userDataPath: root, webRoot: root, env: {} }), {});
  await writeFile(join(root, "cloud-private-preview.json"), JSON.stringify(profile));
  const publicManifest = join(root, "public.json");
  await writeFile(publicManifest, JSON.stringify({ version: 1, accountWebUrl: "https://public.example", accountApiUrl: "https://public.example/api", modelGatewayUrl: "https://public.example/gateway" }));
  assert.deepEqual(privateCloudOptions({ userDataPath: root, webRoot: root, env: {}, endpointManifest: publicManifest }), {}, "Public package takes priority over a stale private profile");
  const legacyOptions = privateCloudOptions({ userDataPath: root, webRoot: root, env: {}, endpointManifest: join(root, "absent.json") });
  assert.equal(legacyOptions.webBaseUrl, "http://localhost:15173");
  await legacyOptions.closeConnection();
  assert.deepEqual(privateCloudOptions({ userDataPath: root, webRoot: root, env: { APORIAX_CLOUD_API_URL: "explicit" } }), {});
  const endpoint = { webBaseUrl: "http://localhost:15173", apiBaseUrl: "http://localhost:14100", modelGatewayBaseUrl: "http://localhost:14200", endpointManifest: join(root, "absent") };
  assert.notEqual(loadCloudEndpoints(endpoint, {}).sessionScope, loadCloudEndpoints({ ...endpoint, connectionIdentity: privateSessionIdentity(profile) }, {}).sessionScope);
  assert.notEqual(privateSessionIdentity(profile), privateSessionIdentity({ ...profile, host: "other.example" }));
  const argv = privateSshArgs(profile, join(root, "known"));
  for (const value of ["StrictHostKeyChecking=yes", "BatchMode=yes", "IdentityAgent=none", "ExitOnForwardFailure=yes", "HostKeyAlgorithms=ssh-ed25519"]) assert.ok(argv.includes(value));
  assert.ok(!argv.includes("-N") && !argv.includes("-n"), "SSH receives EOF on app exit");
  const webRoot = join(root, "web"); await mkdir(join(webRoot, "guide"), { recursive: true });
  await writeFile(join(webRoot, "index.html"), "APP"); await writeFile(join(webRoot, "main.js"), "JS"); await writeFile(join(webRoot, "guide/index.html"), "GUIDE");
  const web = await startPrivateWeb(webRoot, 0); resources.push(() => new Promise(done => { web.close(done); web.closeAllConnections(); }));
  const port = web.address().port;
  const get = (path, headers = {}, method = "GET") => new Promise((done, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, headers, method }, res => { let text = ""; res.on("data", chunk => text += chunk); res.on("end", () => done({ status: res.statusCode, headers: res.headers, text })); }); req.on("error", reject); req.end();
  });
  assert.equal((await get("/account/authorize?code=not-a-secret")).text, "APP");
  assert.equal((await get("/guide/")).text, "GUIDE");
  assert.equal((await get("/main.js")).headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal((await get("/missing.js")).status, 404);
  assert.equal((await get("/", { host: `attacker.example:${port}` })).status, 403);
  for (const path of ["/%2e%2e/key", "/.env", "/%5c..%5ckey"]) assert.equal((await get(path)).status, 403);
  assert.equal((await get("/", {}, "POST")).status, 405);
  assert.equal((await get("/", {}, "HEAD")).text, "");
  const missing = createPrivateCloudBridge({ profile, userDataPath: root, webRoot });
  resources.push(missing.close);
  await assert.rejects(missing.ensureReady(), /KEY_MISSING/);
  await writeFile(profile.identityFile, "test fixture, not a private key");
  await assert.rejects(startPrivateWeb(webRoot, port), /PORT_BUSY/);
  assert.match(accountErrorText("Error invoking handler: APORIAX_PRIVATE_PORT_BUSY", (zh) => zh), /端口被占用/);
  assert.ok(!accountErrorText("private raw error sensitive-data", (zh) => zh).includes("sensitive-data"));

  // The lifecycle tests use an in-memory SSH double, never a real credential.
  let starts = 0, fake, checks = 0;
  const bridge = createPrivateCloudBridge({ profile, userDataPath: root, webRoot, sshExecutable: process.execPath,
    fetchHealth: async url => { checks++; return { ok: true, json: async () => ({ ok: true, service: url.includes("14100") ? "aporiax-cloud-api" : "aporiax-model-gateway" }) }; },
    spawnProcess: (_exe, _args, opts) => {
      assert.equal(opts.shell, false); assert.equal(opts.windowsHide, true); starts++;
      fake = new EventEmitter(); fake.exitCode = null; fake.signalCode = null;
      fake.stdin = new PassThrough(); fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
      fake.kill = () => { fake.exitCode = 0; fake.emit("exit", 0); };
      setTimeout(() => fake.stdout.write("APORIAX_PRIVATE_READY\n"), 10); return fake;
    },
  }); resources.push(bridge.close);
  await Promise.all([bridge.ensureReady(), bridge.ensureReady(), bridge.ensureReady()]); assert.equal(starts, 1); assert.equal(checks, 2);
  await bridge.ensureReady(); assert.equal(starts, 1);
  fake.kill(); await bridge.ensureReady(); assert.equal(starts, 2, "reconnect dead SSH before next operation");
  await bridge.close(); assert.equal(fake.stdin.writableEnded, true); await assert.rejects(bridge.ensureReady(), /CLOSED/);
  const failing = createPrivateCloudBridge({ profile, userDataPath: root, webRoot, sshExecutable: process.execPath, startupTimeout: 100,
    spawnProcess: () => { const p = new EventEmitter(); p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.exitCode = null; p.signalCode = null; p.kill = () => { p.exitCode = 0; p.emit("exit"); }; setTimeout(() => { p.stderr.write("Host key verification failed."); p.kill(); }, 10); return p; },
  }); resources.push(failing.close);
  await assert.rejects(failing.ensureReady(), /HOST_CHANGED/);
  // Failure released the Web port; the next launch may try again.
  const afterFailure = await startPrivateWeb(webRoot); resources.push(() => new Promise(done => afterFailure.close(done)));
  console.log("PASS: profile/trust validation, scoped sessions, SSH arguments, safe static routes, errors, duplicate startup, reconnection and cleanup.");
} finally { for (const close of resources.reverse()) await close(); await rm(root, { recursive: true, force: true }); }

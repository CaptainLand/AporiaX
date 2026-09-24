import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, relative, extname, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadCloudEndpoints } from "./cloud-endpoints.js";

export const PRIVATE_ENDPOINTS = Object.freeze({ webBaseUrl: "http://localhost:15173", apiBaseUrl: "http://localhost:14100", modelGatewayBaseUrl: "http://localhost:14200" });
const fail = code => new Error(`APORIAX_PRIVATE_${code}`);

export function validatePrivateProfile(value) {
  if (value?.version !== 1 || typeof value.host !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(value.host)
    || !/^[a-z_][a-z0-9_-]{0,31}$/.test(value.user || "") || typeof value.identityFile !== "string"
    || !isAbsolute(value.identityFile) || /[\r\n\0]/.test(value.identityFile)
    || !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(value.hostKey || "")) throw fail("CONFIG_INVALID");
  const key = Buffer.from(value.hostKey.split(" ")[1], "base64");
  if (key.length !== 51 || key.readUInt32BE(0) !== 11 || key.subarray(4, 15).toString() !== "ssh-ed25519" || key.readUInt32BE(15) !== 32) throw fail("CONFIG_INVALID");
  const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
  if (value.fingerprint !== fingerprint) throw fail("CONFIG_INVALID");
  return { version: 1, host: value.host, user: value.user, identityFile: value.identityFile, hostKey: value.hostKey, fingerprint };
}

export function readPrivateProfile(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw fail("CONFIG_INVALID"); }
  try { if (text.length > 8192) throw fail("CONFIG_INVALID"); return validatePrivateProfile(JSON.parse(text)); }
  catch { throw fail("CONFIG_INVALID"); }
}

export function privateSessionIdentity(profile) {
  return `ssh:${profile.user}@${profile.host}:22:${profile.fingerprint}`;
}

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" };
export async function startPrivateWeb(root, port = 15173) {
  const base = await realpath(root).catch(() => { throw fail("WEB_MISSING"); });
  await stat(join(base, "index.html")).catch(() => { throw fail("WEB_MISSING"); });
  const server = createServer(async (req, res) => {
    const actualPort = server.address()?.port;
    if (![ `localhost:${actualPort}`, `127.0.0.1:${actualPort}` ].includes(req.headers.host)) { res.writeHead(403); res.end(); return; }
    if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405); res.end(); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      const path = decodeURIComponent((req.url || "/").split("?")[0]);
      if (!path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some(p => p === ".." || p.startsWith("."))) { res.writeHead(403); res.end(); return; }
      let target = resolve(base, "." + path);
      const info = await stat(target).catch(() => null);
      if (info?.isDirectory()) target = join(target, "index.html");
      else if (!info && !extname(path)) target = join(base, "index.html");
      target = await realpath(target);
      const rel = relative(base, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) { res.writeHead(403); res.end(); return; }
      const body = await readFile(target);
      res.writeHead(200, { "Content-Type": mime[extname(target)] || "application/octet-stream", "Content-Length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); })
    .catch(error => { server.close(); throw error.code === "EADDRINUSE" ? fail("PORT_BUSY") : fail("WEB_START_FAILED"); });
  return server;
}

async function assertPortFree(port) {
  // Do not silently adopt a manual tunnel or another application's local API.
  for (const host of ["127.0.0.1", "::1"]) {
    await new Promise((done, reject) => {
      const server = createSocketServer(); server.once("error", reject);
      server.listen(port, host, () => server.close(done));
    }).catch(error => { if (!["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) throw fail("PORT_BUSY"); });
  }
}

export function privateSshArgs(profile, knownHosts, platform = process.platform) {
  const empty = platform === "win32" ? "NUL" : "/dev/null";
  return ["-F", empty, "-a", "-x", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`, "-o", `GlobalKnownHostsFile=${empty}`,
    "-o", "HostKeyAlgorithms=ssh-ed25519", "-o", "ConnectTimeout=10", "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-i", profile.identityFile,
    "-L", "127.0.0.1:14100:127.0.0.1:14100", "-L", "127.0.0.1:14200:127.0.0.1:14200",
    `${profile.user}@${profile.host}`, "printf 'APORIAX_PRIVATE_READY\\n'; cat"];
}

export function createPrivateCloudBridge({ profile, userDataPath, webRoot, spawnProcess = spawn, fetchHealth = fetch, startupTimeout = 20000, sshExecutable = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "ssh.exe") : "/usr/bin/ssh" }) {
  profile = validatePrivateProfile(profile);
  let child, web, pending, ready = false, closed = false, lastCheck = 0;
  const options = { ...PRIVATE_ENDPOINTS, connectionIdentity: privateSessionIdentity(profile), ensureConnection: ensureReady, closeConnection: close };
  async function health() {
    const checks = [[14100, "aporiax-cloud-api"], [14200, "aporiax-model-gateway"]];
    await Promise.all(checks.map(async ([port, service]) => {
      const response = await fetchHealth(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
      const result = await response.json();
      if (!response.ok || result.ok !== true || result.service !== service) throw fail("HEALTH_FAILED");
    }));
  }
  async function stopOwned() {
    ready = false;
    const oldChild = child, oldWeb = web; child = null; web = null;
    const stopped = oldChild && oldChild.exitCode === null && oldChild.signalCode === null
      ? new Promise(resolve => { oldChild.once("exit", resolve); const timer = setTimeout(resolve, 2000); timer.unref(); }) : Promise.resolve();
    oldChild?.stdin?.end(); oldChild?.kill();
    const webStopped = oldWeb ? new Promise(resolve => { oldWeb.close(resolve); oldWeb.closeAllConnections(); }) : Promise.resolve();
    await Promise.all([stopped, webStopped]);
  }
  function ensureReady() {
    if (closed) return Promise.reject(fail("CLOSED"));
    if (pending) return pending;
    pending = (async () => {
      if (ready && child?.exitCode === null && child?.signalCode === null) {
        if (Date.now() - lastCheck < 5000) return;
        try { await health(); lastCheck = Date.now(); return; } catch { /* Rebuild before the next business request, never replay it. */ }
      }
      await stopOwned();
      if (closed) throw fail("CLOSED");
      const key = await stat(profile.identityFile).catch(() => null);
      if (!key?.isFile()) throw fail("KEY_MISSING");
      await stat(sshExecutable).catch(() => { throw fail("SSH_MISSING"); });
      await mkdir(userDataPath, { recursive: true });
      const knownHosts = join(userDataPath, "cloud-private-known-hosts");
      await writeFile(knownHosts, `${profile.host} ${profile.hostKey}\n`, { mode: 0o600 });
      for (const port of [14100, 14200, 15173]) await assertPortFree(port);
      if (closed) throw fail("CLOSED");
      web = await startPrivateWeb(webRoot);
      if (closed) throw fail("CLOSED");
      child = spawnProcess(sshExecutable, privateSshArgs(profile, knownHosts), { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      const processChild = child;
      let marker = "", stderr = "", failure = null;
      processChild.stdin.on("error", () => {});
      processChild.stdout.on("data", data => { marker = (marker + data).slice(-1024); });
      processChild.stderr.on("data", data => { stderr = (stderr + data).slice(-4096); });
      processChild.on("error", () => { failure = fail("SSH_START_FAILED"); });
      processChild.on("exit", () => { ready = false; failure = fail(/host key verification failed|REMOTE HOST IDENTIFICATION/i.test(stderr) ? "HOST_CHANGED" : /Permission denied/i.test(stderr) ? "SSH_AUTH_FAILED" : /Address already in use|cannot listen to port/i.test(stderr) ? "PORT_BUSY" : "CONNECTION_FAILED"); });
      const deadline = Date.now() + startupTimeout;
      while (Date.now() < deadline) {
        if (closed) throw fail("CLOSED");
        if (failure) throw failure;
        if (marker.includes("APORIAX_PRIVATE_READY")) {
          try { await health(); if (failure) throw failure; if (closed) throw fail("CLOSED"); ready = true; lastCheck = Date.now(); return; } catch (error) { if (failure || closed) throw error; }
        }
        await delay(200);
      }
      throw failure || fail("CONNECTION_TIMEOUT");
    })().catch(async error => { await stopOwned(); throw error; }).finally(() => { pending = null; });
    return pending;
  }
  function close() { closed = true; return stopOwned().then(() => pending?.catch(() => {})); }
  return { options, ensureReady, close };
}

export function privateCloudOptions({ userDataPath, webRoot, env = process.env, endpointManifest }) {
  if (["APORIAX_ACCOUNT_WEB_URL", "APORIAX_CLOUD_API_URL", "APORIAX_MODEL_GATEWAY_URL"].some(key => env[key])) return {};
  // A public release must not inherit an obsolete local SSH preview profile.
  // Explicit development endpoints still take precedence; never delete that profile.
  if (loadCloudEndpoints({ endpointManifest }, env).source === "explicit") return {};
  let profile;
  try { profile = readPrivateProfile(join(userDataPath, "cloud-private-preview.json")); }
  catch (error) { return { ...PRIVATE_ENDPOINTS, ensureConnection: async () => { throw error; } }; }
  if (!profile) return {};
  return createPrivateCloudBridge({ profile, userDataPath, webRoot }).options;
}

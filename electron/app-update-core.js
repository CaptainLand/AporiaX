export const GITHUB_OWNER = "CaptainLand";
export const GITHUB_REPO = "AporiaX";
export const RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
export const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;
export const LATEST_YML_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download/latest.yml`;
export const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000;
export const UPDATE_STATE_FILE = "app-update-state.json";

export function isPortableBuild(env = process.env) {
  return Boolean(
    String(env?.PORTABLE_EXECUTABLE_FILE || "").trim() ||
      String(env?.PORTABLE_EXECUTABLE_DIR || "").trim(),
  );
}

export function updateChannel({ packaged = false, portable = false } = {}) {
  if (!packaged) return "dev";
  return portable ? "portable" : "nsis";
}

function versionParts(value) {
  const match = String(value || "").trim().replace(/^v/i, "").match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match || match[4]?.split(".").some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")) return null;
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") || [] };
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) throw new Error("INVALID_UPDATE_VERSION");
  for (let index = 0; index < 3; index += 1) {
    const delta = a.core[index] - b.core[index];
    if (delta > 0) return 1;
    if (delta < 0) return -1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index], y = b.pre[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function isNewerVersion(remote, current) {
  return compareVersions(remote, current) > 0;
}

export function parseLatestYml(text) {
  const source = String(text || "");
  const version =
    source.match(/^\s*version:\s*["']?([0-9][0-9A-Za-z.+-]*)/m)?.[1] || "";
  const path =
    source.match(/^\s*path:\s*["']?([^\s"']+)/m)?.[1] ||
    source.match(/^\s*-\s*url:\s*["']?([^\s"']+)/m)?.[1] ||
    "";
  const result = { version, path };
  const block = source.split(/^\s*-\s*url:\s*/m).slice(1).find(value =>
    value.match(/^["']?([^\s"']+)/)?.[1] === path);
  const sha512 = block?.match(/^\s+sha512:\s*["']?([A-Za-z0-9+/=]+)/m)?.[1];
  const size = Number(block?.match(/^\s+size:\s*(\d+)/m)?.[1]);
  const rootHash = source.match(/^sha512:\s*["']?([A-Za-z0-9+/=]+)/m)?.[1];
  if (sha512 && (!rootHash || sha512 === rootHash)) result.sha512 = sha512;
  if (Number.isSafeInteger(size) && size > 0) result.size = size;
  return result;
}

export function sameUpdateAsset(left, right) {
  return Boolean(left && right && /^[A-Za-z0-9+/]{86}==$/.test(left.sha512 || '') &&
    Number.isSafeInteger(left.size) && left.size > 0 && left.version === right.version &&
    left.path === right.path && left.sha512 === right.sha512 && left.size === right.size);
}
export function matchesUpdateInfo(asset, info) {
  return sameUpdateAsset(asset, { version: info?.version, path: asset?.path,
    ...info?.files?.find(file => file.url === asset?.path) });
}
export function retryableUpdateFailure(error) {
  const code = String(error?.code || ''), message = String(error?.message || error || '');
  if (/checksum|sha512|signature|signing|certificate|cert_|cancel|mismatch|invalid_update/i.test(code + ' ' + message)) return false;
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ERR_NETWORK|ERR_INTERNET|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/i.test(code + ' ' + message) ||
    /network|timed?\s*out|fetch failed|HTTP\s*(?:403|404|408|429|5\d\d)/i.test(message);
}

export function shouldSkipAutoCheck(
  lastCheckedAt,
  now = Date.now(),
  intervalMs = AUTO_CHECK_INTERVAL_MS,
) {
  const last = Number(lastCheckedAt) || 0;
  return last > 0 && Number(now) >= last && Number(now) - last < Number(intervalMs);
}

export function installUpdateDecision({
  channel = "",
  downloaded = false,
  activeRuns = 0,
} = {}) {
  if (channel !== "nsis") {
    return { ok: false, code: "UNSUPPORTED_CHANNEL" };
  }
  if (!downloaded) return { ok: false, code: "NOT_DOWNLOADED" };
  if (Number(activeRuns) > 0) return { ok: false, code: "TASK_RUNNING" };
  return { ok: true };
}

export function createUpdateStatus({
  phase = "idle",
  currentVersion = "",
  availableVersion = "",
  channel = "dev",
  packaged = false,
  downloadPercent = 0,
  error = "",
  releaseUrl = LATEST_RELEASE_URL,
  mirrorAvailable = false,
  downloadSource = 'github',
} = {}) {
  return {
    phase,
    currentVersion: String(currentVersion || ""),
    availableVersion: String(availableVersion || ""),
    channel,
    packaged: Boolean(packaged),
    downloadPercent: Math.max(0, Math.min(100, Number(downloadPercent) || 0)),
    error: String(error || ""),
    releaseUrl: String(releaseUrl || LATEST_RELEASE_URL),
    mirrorAvailable: Boolean(mirrorAvailable),
    downloadSource: downloadSource === 'mirror' ? 'mirror' : 'github',
    busy: ["checking", "downloading"].includes(phase),
  };
}

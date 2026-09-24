export const GITHUB_OWNER = "CaptainLand";
export const GITHUB_REPO = "AporiaX";
export const RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
export const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;
export const LATEST_YML_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download/latest.yml`;
export const AUTO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
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
  const match = String(value || "").trim().replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  return match ? { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") || [] } : null;
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    const delta = a.core[index] - b.core[index];
    if (delta > 0) return 1;
    if (delta < 0) return -1;
  }
  // A final version is newer than its prereleases; build metadata is ignored.
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index], y = b.pre[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : BigInt(x) < BigInt(y) ? -1 : 0;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
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
  return { version, path };
}

export function shouldSkipAutoCheck(
  lastCheckedAt,
  now = Date.now(),
  intervalMs = AUTO_CHECK_INTERVAL_MS,
) {
  const last = Number(lastCheckedAt) || 0;
  return last > 0 && Number(now) - last < Number(intervalMs);
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
    busy: ["checking", "downloading"].includes(phase),
  };
}

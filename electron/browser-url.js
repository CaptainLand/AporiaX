export function normalizeBrowserUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error("Browser URL must be an absolute http/https URL.");
  }
  let candidate = raw;
  if (!/^[a-z][a-z\d+.-]*:/i.test(raw)) {
    if (/\s/.test(raw)) {
      throw new Error("Browser URL must be an absolute http/https URL.");
    }
    candidate = raw.startsWith("//") ? `https:${raw}` : `https://${raw}`;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Browser URL must be an absolute http/https URL.");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("AporiaX Browser only allows http and https URLs.");
  }
  if (url.username || url.password) {
    throw new Error("Credentials embedded in browser URLs are not allowed.");
  }
  return url.toString();
}

export function navigationTarget(event, url) {
  if (typeof event?.url === "string" && event.url) return event.url;
  if (typeof url === "string" && url) return url;
  return "";
}

export function isAllowedBrowserNavigation(target) {
  const value = String(target || "").trim();
  if (!value || value === "about:blank") return true;
  try {
    normalizeBrowserUrl(value);
    return true;
  } catch {
    return false;
  }
}

export function isNavigationAbort(error) {
  return error?.code === "ERR_ABORTED" || error?.errno === -3;
}

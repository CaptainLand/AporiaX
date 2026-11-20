// Browser-safe preview capability list shared with the renderer.
const PREVIEWABLE = /\.(?:js|jsx|ts|tsx|mjs|cjs|json|css|scss|less|html?|md|markdown|txt|xml|ya?ml|toml|svg|png|jpe?g|webp|gif|docx|py|rs|go|java|c|cc|cpp|h|hpp|cs|vue|svelte|php|rb|sh|ps1|sql|log|csv)$/i;

export function isPreviewableWorkbenchPath(path) {
  return PREVIEWABLE.test(String(path || "").replaceAll("\\", "/").split("/").pop());
}

export function agentPresentationKind(path) {
  const value = String(path || "").trim().replace(/^<|>$/g, "");
  if (/\.html?$/i.test(value)) return "browser";
  // Match the rendered document/image types supported by FilePane.
  if (/\.(?:md|markdown|pdf|docx|png|jpe?g|webp|gif)$/i.test(value)) return "document";
  return "link";
}

export function requestsBrowserPresentation({ path, files, url, show_browser } = {}) {
  return Boolean(url || show_browser || [path, ...(Array.isArray(files) ? files : [])].some(p => agentPresentationKind(p) === "browser"));
}

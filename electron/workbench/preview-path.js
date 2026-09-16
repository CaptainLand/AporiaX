// Browser-safe preview capability list shared with the renderer.
const PREVIEWABLE = /\.(?:js|jsx|ts|tsx|mjs|cjs|json|css|scss|less|html?|md|markdown|txt|xml|ya?ml|toml|svg|png|jpe?g|webp|gif|docx|py|rs|go|java|c|cc|cpp|h|hpp|cs|vue|svelte|php|rb|sh|ps1|sql|log|csv)$/i;

export function isPreviewableWorkbenchPath(path) {
  return PREVIEWABLE.test(String(path || "").replaceAll("\\", "/").split("/").pop());
}

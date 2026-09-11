// Old tasks used sandbox-auto as their default; the requested new default is
// full-auto. Explicit manual/smart choices remain available and are preserved.
export function taskApprovalMode(value) {
  return value === "manual" || value === "smart-auto" ? value : "full-auto";
}

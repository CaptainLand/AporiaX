// Shared declarative schema only; no command execution or filesystem access.
const text = (value, limit = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) throw new Error("ACCEPTANCE_INVALID_TEXT");
  return value;
};
const path = (value) => {
  text(value, 500);
  if (value.startsWith("/") || /^[a-z]:/i.test(value) || value.startsWith("\\") || value.split(/[\\/]/).some((part) => ["..", ""].includes(part)))
    throw new Error("ACCEPTANCE_OUTSIDE_WORKSPACE");
  return value.replaceAll("\\", "/");
};
export function normalizeTaskContract(input) {
  if (input == null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input) || input.version !== 1 ||
      !Array.isArray(input.requirements) || input.requirements.length < 1 || input.requirements.length > 32 ||
      (input.enforce !== undefined && typeof input.enforce !== "boolean") || JSON.stringify(input).length > 64_000)
    throw new Error("ACCEPTANCE_CONTRACT_INVALID");
  const ids = new Set();
  const requirements = input.requirements.map((item) => {
    if (!item || !/^[a-zA-Z0-9_-]{1,60}$/.test(item.id) || ids.has(item.id)) throw new Error("ACCEPTANCE_INVALID_ID");
    ids.add(item.id); text(item.text, 1000);
    if (!Array.isArray(item.checks) || item.checks.length > 8) throw new Error("ACCEPTANCE_INVALID_CHECKS");
    const checks = item.checks.map((check) => {
      if (!check || typeof check !== "object") throw new Error("ACCEPTANCE_INVALID_CHECK");
      if (["file_exists", "file_contains", "json_value"].includes(check.type)) {
        const value = { type: check.type, path: path(check.path) };
        if (check.type === "file_contains") value.text = text(check.text, 4000);
        if (check.type === "json_value") {
          if (!Array.isArray(check.keys) || check.keys.length > 20 || check.keys.some((key) => typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)))
            throw new Error("ACCEPTANCE_INVALID_JSON_PATH");
          if (check.equals === undefined || JSON.stringify(check.equals).length > 4000) throw new Error("ACCEPTANCE_INVALID_JSON_VALUE");
          value.keys = [...check.keys]; value.equals = structuredClone(check.equals);
        }
        return value;
      }
      if (check.type === "command_exit") {
        if (!Array.isArray(check.inputs) || !check.inputs.length || check.inputs.length > 16) throw new Error("ACCEPTANCE_COMMAND_REQUIRES_INPUTS");
        return { type: "command_exit", command: text(check.command, 2000).trim(), cwd: path(check.cwd || "."), inputs: check.inputs.map(path) };
      }
      throw new Error("ACCEPTANCE_UNSUPPORTED_CHECK");
    });
    return { id: item.id, text: item.text, checks };
  });
  return { version: 1, enforce: input.enforce !== false, requirements };
}

import { createHash } from "node:crypto";

export const CONTROL_API_VERSION = 1;
export const CONTROL_API_PATH = "/control/v1";
export const CONTROL_PROFILES = Object.freeze([
  { id: "review", name: "Read-only review", permissionProfile: "read_only" },
  { id: "workspace", name: "Workspace editing", permissionProfile: "workspace_edit" },
]);
export const DEFAULT_LIMITS = Object.freeze({
  maxDurationSeconds: 1800, maxModelCalls: 80, maxToolCalls: 400,
  maxParallelAgents: 2, maxSubagents: 12,
});
export const MAX_LIMITS = Object.freeze({
  maxDurationSeconds: 86400, maxModelCalls: 2000, maxToolCalls: 10000,
  maxParallelAgents: 8, maxSubagents: 100,
});
export const TERMINAL_STATES = new Set(["completed", "partial", "blocked", "failed", "interrupted", "cancelled"]);
export const ACTIVE_STATES = new Set(["starting", "running", "paused", "waiting_question", "waiting_approval", "cancelling"]);

export class ControlError extends Error {
  constructor(statusCode, code, message, details) {
    super(message || code); this.name = "ControlError"; this.statusCode = statusCode;
    this.code = code; if (details !== undefined) this.details = details;
  }
}
export const fail = (status, code, message, details) => { throw new ControlError(status, code, message, details); };
export function object(value, allowed, name = "request") {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    fail(400, "invalid_request", `${name} must be a JSON object.`);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) fail(400, "unknown_fields", `Unsupported ${name} fields: ${extra.join(", ")}.`);
  return value;
}
export function text(value, name, max = 4000, { optional = false } = {}) {
  if (optional && (value === undefined || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
    fail(400, "invalid_request", `${name} must be nonempty text of at most ${max} characters.`);
  return value.trim();
}
export function integer(value, name, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > max)
    fail(400, "invalid_request", `${name} must be an integer between ${min} and ${max}.`);
  return number;
}
export function stringArray(value, name, { optional = false, max = 100 } = {}) {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value) || (!optional && value.length === 0) || value.length > max)
    fail(400, "invalid_request", `${name} must contain ${optional ? "0" : "1"}–${max} values.`);
  return [...new Set(value.map(item => text(item, name, 200)))];
}
export function normalizeLimits(value = {}, ceiling = MAX_LIMITS, defaults = DEFAULT_LIMITS) {
  object(value, Object.keys(DEFAULT_LIMITS), "limits");
  return Object.fromEntries(Object.keys(DEFAULT_LIMITS).map(key => [key,
    integer(value[key], key, Math.min(defaults[key], ceiling[key]), key === "maxDurationSeconds" ? 1 : 0, ceiling[key]),
  ]));
}
export function snakeCase(value) {
  if (Array.isArray(value)) return value.map(snakeCase);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), snakeCase(item)]));
}
export function camelCase(value) {
  if (Array.isArray(value)) return value.map(camelCase);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), camelCase(item)]));
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
export const requestHash = value => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
export const tokenHash = token => createHash("sha256").update(token).digest("hex");
export function terminalStatus(result) {
  const status = String(result?.status || "");
  if (TERMINAL_STATES.has(status)) return status;
  if (result?.error) return "failed";
  return "completed";
}

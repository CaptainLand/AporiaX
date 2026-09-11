import { createHash } from "node:crypto";
import { diffLines } from "diff";
import { buildChanges, createChangeVersionSignature, findVerificationCandidate } from "./self-check-evidence.js";

export const contentHash = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");
export const verificationVersion = (changes) => createChangeVersionSignature(buildChanges(changes));
const commandKey = (value) => JSON.stringify([value.command?.trim(), value.cwd || "."]);

export function commandOutputPreview(result = {}, limit = 8000) {
  const output = String(result?.output || result?.preview || "").trim();
  if (output) return output.slice(-limit);
  return [result?.stdout, result?.stderr]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(-limit);
}

export function refreshVerification(state, changes) {
  const version = verificationVersion(changes);
  const latest = new Map();
  for (const item of state.verificationResults || []) {
    if (item.versionSignature === version) latest.set(commandKey(item), item);
  }
  // Candidates are suggestions, not a mandate to run every expensive script.
  const required = state.verificationRequired || [];
  state.verificationAttempted = latest.size > 0;
  state.verificationPassed = latest.size > 0 && [...latest.values()].every((item) => item.passed === true) &&
    required.every((candidate) => latest.get(commandKey(candidate))?.passed === true);
  return version;
}

export function recordVerification(state, changes, item, versionSignature = verificationVersion(changes)) {
  const candidate = findVerificationCandidate(state.verificationCandidates || [], item);
  state.verificationResults.push({ ...item, passed: item.passed === true && !item.error && !item.timedOut, command: candidate?.command || item.command, cwd: candidate?.cwd || item.cwd || ".", versionSignature, observedAt: new Date().toISOString() });
  refreshVerification(state, changes);
}

// Offsets are in LF-normalized text; hashes identify the actual bytes read as UTF-8.
export function readEvidenceCovers(change, items) {
  if (!change || change.binary) return false;
  const text = String(change.afterContent ?? "").replace(/\r\n/g, "\n");
  const hash = contentHash(change.afterContent);
  const ranges = items.filter((item) => item.tool === "read_file" && !item.error && item.path === change.path && item.sha256 === hash)
    .map((item) => item.readRange).filter((range) => range && Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end >= range.start)
    .sort((a, b) => a.start - b.start);
  if (!ranges.length) return false;
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  let offset = 0;
  const needed = [];
  for (const part of diffLines(String(change.beforeContent ?? "").replace(/\r\n/g, "\n"), text)) {
    if (part.added || part.removed) {
      const end = offset + (part.removed ? 0 : part.value.length);
      const startContext = text.lastIndexOf("\n", Math.max(0, offset - 2));
      const endContext = text.indexOf("\n", end);
      needed.push({ start: Math.max(0, startContext + 1), end: endContext < 0 ? text.length : endContext + 1 });
    }
    if (!part.removed) offset += part.value.length;
  }
  if (!needed.length) needed.push({ start: 0, end: text.length });
  return needed.every((range) => merged.some((read) => read.start <= range.start && read.end >= range.end));
}

export function recordReadEvidence(state, changes, tool, result) {
  const change = changes.get(result?.path);
  if (!change || result?.error) return;
  state.readEvidence ||= [];
  state.readEvidence = state.readEvidence.filter((item) => item.path !== change.path || item.sha256 === result.sha256);
  state.readEvidence.push({ tool, path: result.path, sha256: result.sha256, readRange: result.readRange });
  if (readEvidenceCovers(change, state.readEvidence)) state.reviewedVersions.set(change.path, change.afterContent);
}

export function selfCheckProgressKey(state, changes) {
  const reads = [...new Set((state.readEvidence || []).map((item) => JSON.stringify([item.path, item.sha256, item.readRange])))].sort();
  const commands = [...new Set((state.verificationResults || []).filter((item) => item.versionSignature === verificationVersion(changes))
    .map((item) => JSON.stringify([item.command, item.cwd, item.passed, item.exitCode, item.error])))].sort();
  return contentHash(JSON.stringify([verificationVersion(changes), reads, commands, [...state.reviewedVersions.keys()].sort()]));
}

export class NoProgressGuard {
  #counts = new Map();
  observe(key, limit = 3) {
    const count = (this.#counts.get(key) || 0) + 1;
    this.#counts.set(key, count);
    if (count >= limit) {
      const error = new Error("VERIFICATION_BLOCKED: repeated self-check failure without new code or evidence. Work is preserved; inspect the reported blocker before retrying.");
      error.code = "VERIFICATION_BLOCKED";
      throw error;
    }
  }
}

export function classifyVerificationFailure(commands = []) {
  const failures = commands.filter((item) => !item.passed);
  if (!failures.length) return null;
  return failures.every((item) => item.exitCode == null && /ENOENT|command not found|not recognized|spawn.*(?:failed|error)|sandbox.*(?:unavailable|not ready)|EACCES|permission denied/i.test([item.error, item.output].join(" ")))
    ? "environment" : "verification";
}

import { buildWitnessRouteBlocks } from "./p0-model.js";

function normalizedLanguage(language) {
  return String(language || "").toLowerCase().startsWith("en")
    ? "en"
    : "zh-CN";
}

function compactValues(values, limit) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit);
}

export function buildAgentProcessSummary(message = {}, language = "zh-CN") {
  const lang = normalizedLanguage(language);
  const run = {
    id: message.id || "assistant-run",
    status: message.status || "completed",
    witness: message.witness || null,
    entries: Array.isArray(message.route) ? message.route : [],
    changes: Array.isArray(message.changes) ? message.changes : [],
    plan: message.plan || null,
  };
  return buildWitnessRouteBlocks(run, lang).map((block) => ({
    id: block.id,
    kind: block.kind,
    status: block.status,
    title: block.title,
    summary: block.summary,
    paths: compactValues(block.paths, 4),
    commands: compactValues(block.commands, 2),
    planSteps: (block.planSteps || []).slice(0, 5).map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      detail: step.detail || "",
    })),
    recordCount: block.records?.length || 0,
  }));
}

export function currentProcessSummary(steps = []) {
  const active = (steps || []).find((step) => step.status === "running");
  return active || (steps || []).at(-1) || null;
}

export function extractWorkspaceMentionQuery(text, cursor) {
  const source = String(text || "");
  const caret = Number.isInteger(cursor)
    ? Math.max(0, Math.min(source.length, cursor))
    : source.length;
  const before = source.slice(0, caret);
  const match = before.match(/(^|\s)@([^\s@{}"]*)$/u);
  if (!match) return null;
  const prefixLength = match[1]?.length || 0;
  const start = caret - match[0].length + prefixLength;
  return {
    start,
    end: caret,
    query: match[2] || "",
  };
}

export function formatWorkspaceMentionToken(path) {
  const normalized = String(path || "")
    .trim()
    .replace(/\\/g, "/");
  if (!normalized) return "@";
  return /^[A-Za-z0-9_.\-/]+$/u.test(normalized)
    ? `@${normalized}`
    : `@{${normalized}}`;
}

export function replaceWorkspaceMentionQuery(text, query, path) {
  const source = String(text || "");
  if (!query || query.start < 0 || query.end < query.start) {
    return { value: source, cursor: source.length };
  }
  const token = `${formatWorkspaceMentionToken(path)} `;
  const value = `${source.slice(0, query.start)}${token}${source.slice(query.end)}`;
  return {
    value,
    cursor: query.start + token.length,
  };
}

function fileScore(path, query) {
  const normalizedPath = String(path || "").toLowerCase();
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return 10;
  const name = normalizedPath.split("/").at(-1) || normalizedPath;
  if (name === normalizedQuery) return 0;
  if (name.startsWith(normalizedQuery)) return 1;
  if (normalizedPath.startsWith(normalizedQuery)) return 2;
  if (name.includes(normalizedQuery)) return 3;
  if (normalizedPath.includes(normalizedQuery)) return 4;
  return Number.POSITIVE_INFINITY;
}

export function rankWorkspaceFiles(paths, query, limit = 12) {
  return [...new Set((paths || []).map((path) => String(path || "").replace(/\\/g, "/")).filter(Boolean))]
    .map((path) => ({ path, score: fileScore(path, query) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => left.score - right.score || left.path.length - right.path.length || left.path.localeCompare(right.path))
    .slice(0, Math.max(1, limit))
    .map((item) => item.path);
}

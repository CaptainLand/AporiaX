import { createHash } from "node:crypto";
import { normalizeTokenUsage } from "./runtime/token-usage.js";
export { mergeTokenUsage } from "./runtime/token-usage.js";
import { isHumanMessage } from "./runtime/task-conversation.js";
import { isAnchorRestoreNotice } from "./anchor-restore-notice.js";
import { conversationTokenMaterial } from "./runtime/multimodal-budget.js";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  join,
  relative,
  resolve,
} from "node:path";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const MIN_CONTEXT_RESERVE_TOKENS = 12_000;
const MAX_MEMORY_FACTS = 240;
const MAX_MEMORY_FACT_CHARS = 1_200;
const MAX_RULE_FILES = 120;
const MAX_RULE_FILE_CHARS = 32_000;
const RELEVANT_CONTEXT_PREFIX = "AporiaX relevant durable context:";
const INSTRUCTION_FILE_NAMES = [
  "AGENTS.md",
  "APORIAX.md",
  "DEEPAGENT.md",
];

function normalizeRelativePath(value) {
  const normalized = String(value || ".")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
  if (!normalized || normalized === ".") return ".";
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split("/").includes("..") ||
    normalized.includes("\0")
  ) {
    throw new Error("Project context paths must stay inside the workspace.");
  }
  return normalized.replace(/\/$/, "") || ".";
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((item) => item?.type === "text")
    .map((item) => item.text || "")
    .join("\n");
}

function normalizeUsageNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function countHeuristicTokens(text) {
  const value = String(text || "");
  if (!value) return 0;
  const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || [])
    .length;
  const latinRuns = value.match(/[A-Za-z0-9_$]+/g) || [];
  const latin = latinRuns.reduce(
    (total, part) => total + Math.max(1, Math.ceil(part.length / 3.6)),
    0,
  );
  const punctuation = (value.match(/[^\sA-Za-z0-9_$\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || [])
    .length;
  return Math.ceil(cjk + latin + punctuation * 0.45);
}

export function createTokenAccounting() {
  return {
    source: "model-aware-heuristic",
    calibratedTokensPerCharacter: 0,
    calibratedHeuristicScale: 1,
    providerOverheadTokens: 0,
    lastPromptTokens: 0,
    lastConversationCharacters: 0,
    lastHeuristicTokens: 0,
    lastProviderOverheadTokens: 0,
    lastMaterialHash: "",
    requests: 0,
  };
}

export function estimateConversationTokens(conversation, accounting = null) {
  const { serialized, imageTokens, imageCount } = conversationTokenMaterial(conversation);
  const heuristic = countHeuristicTokens(serialized);
  const overhead = normalizeUsageNumber(accounting?.providerOverheadTokens);
  // Images never calibrate the text estimator; usage cannot separate their cost.
  if (imageCount || !accounting?.lastMaterialHash) return Math.max(1, heuristic + overhead) + imageTokens;
  const hash = createHash("sha256").update(serialized).digest("hex");
  if (hash === accounting.lastMaterialHash && overhead === accounting.lastProviderOverheadTokens) {
    return accounting.lastPromptTokens;
  }
  // Anchor to ONE measured request, then estimate only the changed material.
  // The baseline already includes schema/protocol overhead. Do not add it twice.
  return Math.max(1, Math.ceil(accounting.lastPromptTokens +
    (heuristic - accounting.lastHeuristicTokens) * accounting.calibratedHeuristicScale +
    overhead - accounting.lastProviderOverheadTokens));
}

export function recordProviderUsage(accounting, usage, conversation) {
  const promptTokens = normalizeTokenUsage(usage)?.prompt_tokens;
  if (!accounting || !Number.isFinite(promptTokens) || promptTokens <= 0) return accounting;
  accounting.requests += 1;
  const { serialized, imageCount } = conversationTokenMaterial(conversation);
  if (imageCount) {
    accounting.source = "multimodal-heuristic";
    return accounting;
  }
  const heuristic = countHeuristicTokens(serialized);
  const overhead = normalizeUsageNumber(accounting.providerOverheadTokens);
  const scale = (promptTokens - overhead) / Math.max(1, heuristic);
  // Implausible/synthetic usage still anchors the identical request, but must
  // not teach an arbitrary per-character rate to every subsequent request.
  if (scale >= 0.1 && scale <= 4) accounting.calibratedHeuristicScale = scale;
  accounting.calibratedTokensPerCharacter = promptTokens / Math.max(1, serialized.length);
  accounting.lastPromptTokens = promptTokens;
  accounting.lastConversationCharacters = serialized.length;
  accounting.lastHeuristicTokens = heuristic;
  accounting.lastProviderOverheadTokens = overhead;
  accounting.lastMaterialHash = createHash("sha256").update(serialized).digest("hex");
  accounting.source = "provider-usage-calibrated";
  return accounting;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function conciseToolEvidence(message) {
  const parsed =
    typeof message?.content === "string"
      ? safeJsonParse(message.content)
      : null;
  if (!parsed) {
    const preview = String(message?.content || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1_200);
    return preview ? { preview } : null;
  }
  const evidence = {
    path: parsed.path || null,
    command: parsed.command || null,
    cwd: parsed.cwd || null,
    query: parsed.query || null,
    exitCode:
      typeof parsed.exitCode === "number" ? parsed.exitCode : null,
    error: parsed.error ? String(parsed.error).slice(0, 500) : null,
    truncated: Boolean(parsed.truncated),
    toolCallId: message.tool_call_id || null,
    ...(parsed.resultRef ? { resultRef: parsed.resultRef } : {}),
    ...(parsed.sha256 ? { sha256: parsed.sha256 } : {}),
    ...(parsed.readRange ? { readRange: parsed.readRange } : {}),
    ...(parsed.timedOut ? { timedOut: true } : {}),
  };
  // A failure without its diagnostic encourages repeating the same command.
  // Retain bounded head AND tail (including assertion/stack locations), not
  // merely exitCode. These remain untrusted observations, never instructions.
  const excerpt = (value, limit = 2400) => {
    const text = typeof value === "string" ? value : "";
    return text.length <= limit ? text : `${text.slice(0, limit / 2)}\n[diagnostic truncated]\n${text.slice(-limit / 2)}`;
  };
  if (parsed.error || parsed.isError || parsed.timedOut || parsed.exitCode !== undefined && parsed.exitCode !== 0) {
    evidence.diagnostic = {
      stdout: excerpt(parsed.stdout || parsed.output || parsed.preview),
      stderr: excerpt(parsed.stderr),
      ...(parsed.isError ? { isError: true } : {}),
    };
  } else if (parsed.summary || parsed.message) evidence.summary = excerpt(parsed.summary || parsed.message, 800);
  if (Array.isArray(parsed.matches)) {
    evidence.matches = parsed.matches
      .slice(0, 12)
      .map((match) => ({
        path: match?.path || null,
        line: match?.line || null,
        preview: String(match?.preview || match?.text || "").slice(0, 240),
      }));
  }
  if (Array.isArray(parsed.entries)) {
    evidence.entries = parsed.entries.slice(0, 30);
  }
  if (Array.isArray(parsed.workspaceChanges)) {
    evidence.workspaceChanges = parsed.workspaceChanges.slice(0, 30);
  }
  return evidence;
}

function uniqueRecent(values, limit) {
  if (limit <= 0) return [];
  const output = [];
  const seen = new Set();
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    const key = typeof value === "string" ? value : JSON.stringify(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.unshift(value);
    if (output.length >= limit) break;
  }
  return output;
}

export function buildStructuredContextCheckpoint(
  messages,
  { plan = null, relevantMemory = [] } = {},
) {
  const requirements = [];
  const decisions = [];
  const actions = [];
  const evidence = [];
  const failures = [];
  const files = [];
  const commands = [];

  for (const message of messages || []) {
    const text = messageText(message).replace(/\s+/g, " ").trim();
    if (isHumanMessage(message) && text && !message.aporiaSupersededBy) {
      requirements.push(text);
    } else if (message?.role === "assistant") {
      if (text) decisions.push(text.slice(0, 1_200));
      for (const call of message.tool_calls || []) {
        const input = safeJsonParse(call?.function?.arguments || "") || {};
        const action = {
          tool: call?.function?.name || "unknown",
          path: input.path || null,
          command: input.command || null,
          query: input.query || null,
          task: input.task ? String(input.task).slice(0, 500) : null,
        };
        actions.push(action);
        if (action.path) files.push(action.path);
        if (action.command) commands.push(action.command);
      }
    } else if (message?.role === "tool") {
      const item = conciseToolEvidence(message);
      if (!item) continue;
      evidence.push(item);
      if (item.path) files.push(item.path);
      if (item.command) commands.push(item.command);
      if (item.error || item.timedOut || item.diagnostic?.isError || (typeof item.exitCode === "number" && item.exitCode !== 0)) {
        failures.push(item);
      }
    }
  }

  return {
    version: 2,
    createdAt: new Date().toISOString(),
    requirements: uniqueRecent(requirements, 12),
    decisions: uniqueRecent(decisions, 12),
    actions: uniqueRecent(actions, 40),
    evidence: uniqueRecent(evidence, 50),
    failures: uniqueRecent(failures, 16),
    files: uniqueRecent(files, 60),
    commands: uniqueRecent(commands, 20),
    plan: plan
      ? {
          revision: plan.revision || 1,
          steps: (plan.steps || []).slice(0, 20),
        }
      : null,
    // Project recall is replaceable; never freeze it into a task checkpoint.
    relevantMemory: [],
    compactedMessages: (messages || []).length,
    recoveryInstruction:
      "Treat this checkpoint as a durable index. Re-read files or rerun tools before relying on exact older output.",
  };
}

function leadingSystemCount(conversation) {
  let count = 0;
  while (conversation[count]?.role === "system") count += 1;
  return count;
}

export function compactConversationForRequest({
  conversation,
  onEvent,
  contextCheckpoints,
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
  accounting = null,
  plan = null,
  relevantMemory = [],
  inputBudgetTokens = null,
}) {
  if (inputBudgetTokens !== null && (!Number.isSafeInteger(inputBudgetTokens) || inputBudgetTokens <= 0)) {
    throw new TypeError("inputBudgetTokens must be a positive integer.");
  }
  const reserveTokens = Math.min(Math.floor(contextWindowTokens * 0.4), Math.max(
    MIN_CONTEXT_RESERVE_TOKENS, Math.floor(contextWindowTokens * 0.14),
  ));
  const compactAtTokens = Math.max(1, Math.min(contextWindowTokens - reserveTokens, inputBudgetTokens ?? Infinity));
  const estimatedTokensBefore = estimateConversationTokens(
    conversation,
    accounting,
  );
  if (estimatedTokensBefore <= compactAtTokens) return null;

  // First reclaim old, closed tool output only when a task-owned full-result
  // reference exists. Recent exchanges stay verbatim; failure diagnostics and
  // byte-page references survive. Never mutate the caller on budget failure.
  let prunedToolOutputs = 0;
  const workingConversation = conversation.map((message, index) => {
    if (index >= conversation.length - 8 || message.role !== "tool" ||
        typeof message.content !== "string" || message.content.length <= 8_000) return message;
    const value = safeJsonParse(message.content);
    if (!value?.resultRef?.id || value.resultRef.readTool !== "mcp_read_result") return message;
    const summary = JSON.stringify({ ...conciseToolEvidence(message), contextCompacted: true,
      note: "Full original tool result retained. Use resultRef.readTool with result_id=resultRef.id and nextOffset; do not repeat a side-effecting tool just to recover output." });
    if (summary.length >= message.content.length) return message;
    prunedToolOutputs++;
    return { ...message, content: summary };
  });
  if (prunedToolOutputs && estimateConversationTokens(workingConversation, accounting) <= compactAtTokens) {
    const checkpoint = { ...buildStructuredContextCheckpoint([], { plan }), prunedToolOutputs };
    conversation.splice(0, conversation.length, ...workingConversation);
    contextCheckpoints.push(checkpoint);
    if (contextCheckpoints.length > 8) contextCheckpoints.splice(0, contextCheckpoints.length - 8);
    onEvent?.({ type: "context.compacted", checkpoint, reason: "archived-tool-output-prune",
      compactedMessages: 0, estimatedTokensBefore,
      estimatedTokensAfter: estimateConversationTokens(conversation, accounting), contextWindowTokens });
    return checkpoint;
  }

  const prefix = "AporiaX durable context checkpoint:\n";
  const previous = [];
  const messages = workingConversation.filter((message) => {
    if (message.role !== "system" || !String(message.content).startsWith(prefix)) return true;
    const value = safeJsonParse(message.content.slice(prefix.length));
    if (value) previous.push(value);
    return false;
  });
  const systemCount = leadingSystemCount(messages);
  const instructions = messages.slice(0, systemCount);
  // Keep an assistant tool call and ALL of its results in one history unit.
  const groups = [];
  for (const message of messages.slice(systemCount)) {
    if (message.role === "tool" && groups.at(-1)?.[0]?.tool_calls?.length) groups.at(-1).push(message);
    else groups.push([message]);
  }
  const latestUser = groups.findLastIndex((group) => isHumanMessage(group[0]));
  const protectedGroup = (index) => index === latestUser ||
    groups[index].some((message) => message.aporiaTaskBrief === true) ||
    groups[index].some((message) => message.aporiaPinned && isHumanMessage(message)) ||
    groups[index].some((message) => isAnchorRestoreNotice(message)) ||
    (groups[index][0].role === "system" && groups[index][0].aporiaSource !== "retrieval");
  const retained = new Set(groups.map((_, index) => index));
  let omitted = [];
  let checkpoint;
  let candidate;
  let summaryLimit = 12;
  let compactedToolOutput = false;
  const limits = { requirements: 12, decisions: 12, actions: 40, evidence: 50, failures: 16, files: 60, commands: 20 };
  const rebuild = () => {
    checkpoint = buildStructuredContextCheckpoint(omitted, { plan, relevantMemory });
    for (const [key, limit] of Object.entries(limits)) {
      checkpoint[key] = uniqueRecent([...previous.flatMap((item) => item[key] || []), ...checkpoint[key]], Math.min(limit, summaryLimit));
    }
    checkpoint.compactedMessages += previous.reduce((sum, item) => sum + (item.compactedMessages || 0), 0);
    checkpoint.relevantMemory = checkpoint.relevantMemory.slice(0, Math.min(4, summaryLimit));
    if (checkpoint.plan) checkpoint.plan.steps = checkpoint.plan.steps.slice(0, summaryLimit);
    candidate = [...instructions, { role: "system", content: prefix + JSON.stringify(checkpoint) },
      ...groups.flatMap((group, index) => retained.has(index) ? group : [])];
  };
  // Start with a bounded tail; never silently truncate the latest user request.
  let count = 0;
  for (let index = groups.length - 1; index >= 0; index--) {
    count += groups[index].length;
    if (count > 16 && !protectedGroup(index)) retained.delete(index);
  }
  const updateOmitted = () => { omitted = groups.flatMap((group, index) => retained.has(index) ? [] : group); };
  updateOmitted();
  rebuild();
  while (estimateConversationTokens(candidate, accounting) > compactAtTokens) {
    const removable = [...retained].find((index) => !protectedGroup(index) && index !== groups.length - 1);
    if (removable !== undefined) {
      retained.delete(removable);
      updateOmitted();
    } else if (summaryLimit > 0) {
      summaryLimit = Math.floor(summaryLimit / 2);
    } else if (!compactedToolOutput) {
      compactedToolOutput = true;
      for (const index of retained) groups[index] = groups[index].map((message) => message.role === "tool"
        ? { ...message, content: JSON.stringify({ ...conciseToolEvidence(message), contextCompacted: true, note: "Full output omitted; re-read the relevant range if needed." }) }
        : message);
    } else {
      const error = new Error("CONTEXT_BUDGET_EXCEEDED: system instructions or the latest request/tool exchange exceed the available input budget. Narrow the request or use a larger context window.");
      error.code = "CONTEXT_BUDGET_EXCEEDED";
      const material = conversationTokenMaterial(candidate);
      error.budget = { contextWindowTokens, reserveTokens, inputBudget: compactAtTokens,
        estimatedTokens: estimateConversationTokens(candidate, accounting), imageCount: material.imageCount,
        estimatedImageTokens: material.imageTokens, estimator: "multimodal-heuristic" };
      throw error;
    }
    rebuild();
  }
  conversation.splice(0, conversation.length, ...candidate);
  contextCheckpoints.push(checkpoint);
  if (contextCheckpoints.length > 8) contextCheckpoints.splice(0, contextCheckpoints.length - 8);
  const estimatedTokensAfter = estimateConversationTokens(
    conversation,
    accounting,
  );
  onEvent?.({
    type: "context.compacted",
    checkpoint,
    compactedMessages: omitted.length,
    estimatedTokensBefore,
    estimatedTokensAfter,
    contextWindowTokens,
    estimator: accounting?.source || "model-aware-heuristic",
  });
  return checkpoint;
}

function relevanceTerms(value) {
  const text = String(value || "").toLowerCase();
  const terms = text.match(/[a-z0-9_$./\\-]{2,}|[\u3400-\u9fff]/g) || [];
  const cjk = [...text.matchAll(/[\u3400-\u9fff]{2,}/g)].flatMap((match) => {
    const value = match[0];
    const pairs = [];
    for (let index = 0; index < value.length - 1; index += 1) {
      pairs.push(value.slice(index, index + 2));
    }
    return pairs;
  });
  return [...terms, ...cjk].slice(0, 2_000);
}

function relevanceScore(query, candidate) {
  const queryTerms = relevanceTerms(query);
  const candidateTerms = relevanceTerms(candidate);
  if (!queryTerms.length || !candidateTerms.length) return 0;
  const queryCounts = new Map();
  const candidateCounts = new Map();
  for (const term of queryTerms) {
    queryCounts.set(term, (queryCounts.get(term) || 0) + 1);
  }
  for (const term of candidateTerms) {
    candidateCounts.set(term, (candidateCounts.get(term) || 0) + 1);
  }
  let dot = 0;
  let queryNorm = 0;
  let candidateNorm = 0;
  for (const count of queryCounts.values()) queryNorm += count * count;
  for (const [term, count] of candidateCounts) {
    candidateNorm += count * count;
    dot += count * (queryCounts.get(term) || 0);
  }
  if (!dot) return 0;
  return dot / Math.sqrt(queryNorm * candidateNorm);
}

export function retrieveRelevantContext({
  query,
  checkpoints = [],
  memoryFacts = [],
  limit = 8,
}) {
  const candidates = [];
  for (const fact of memoryFacts || []) {
    candidates.push({
      kind: "memory",
      value: fact,
      text: `${fact.category || "fact"} ${fact.content || ""} ${fact.evidence || ""}`,
    });
  }
  for (const checkpoint of checkpoints || []) {
    for (const requirement of checkpoint.requirements || checkpoint.goals || []) {
      candidates.push({
        kind: "requirement",
        value: { content: requirement, checkpoint: checkpoint.createdAt },
        text: requirement,
      });
    }
    for (const decision of checkpoint.decisions || []) {
      candidates.push({
        kind: "decision",
        value: { content: decision, checkpoint: checkpoint.createdAt },
        text: decision,
      });
    }
    for (const item of checkpoint.evidence || []) {
      candidates.push({
        kind: "evidence",
        value: item,
        text: JSON.stringify(item),
      });
    }
  }
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: relevanceScore(query, candidate.text),
    }))
    .filter((candidate) => candidate.score > 0.04)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ kind, value, score }) => ({ kind, value, score }));
}

const relevantContextState = new WeakMap();

function isRelevantContextMessage(message) {
  return (
    message?.role === "system" &&
    String(message?.content || "").startsWith(RELEVANT_CONTEXT_PREFIX)
  );
}

function removeRelevantContextMessages(conversation) {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (isRelevantContextMessage(conversation[index])) {
      conversation.splice(index, 1);
    }
  }
}

export function upsertRelevantContextMessage(
  conversation,
  { checkpoints = [], memoryFacts = [], plan = null, refresh = false } = {},
) {
  // Old saved runs may contain project recall copied into a checkpoint. Keep
  // task evidence and decisions, but reload optional knowledge from its store.
  const checkpointPrefix = "AporiaX durable context checkpoint:\n";
  for (const message of conversation) {
    if (message?.role !== "system" || typeof message.content !== "string" || !message.content.startsWith(checkpointPrefix)) continue;
    try {
      const checkpoint = JSON.parse(message.content.slice(checkpointPrefix.length));
      if (checkpoint.relevantMemory?.length) {
        checkpoint.relevantMemory = [];
        message.content = checkpointPrefix + JSON.stringify(checkpoint);
      }
    } catch { /* Preserve malformed legacy evidence; recovery reports its integrity separately. */ }
  }
  const state = relevantContextState.get(conversation);
  const history = conversation.filter((message) => message?.role !== "system" && !isRelevantContextMessage(message));
  const query = [
    ...history.slice(-8).map((message) => messageText(message).slice(-2400)),
    ...(plan?.steps || []).filter((step) => step.status === "in_progress").map((step) => `${step.title} ${step.detail || ""}`),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(-24_000);
  const key = createHash("sha256").update(JSON.stringify({ query, checkpoints, memoryFacts })).digest("hex");
  const relevant = !refresh && state?.key === key ? state.items : retrieveRelevantContext({
    query,
    checkpoints,
    memoryFacts,
  }).map(({ kind, value }) => ({ kind, value }));
  // Dynamic retrieval belongs near the tail, never before the stable system
  // prefix. Remove obsolete context, including the old prefix-style injection.
  const existing = conversation.find(isRelevantContextMessage);
  if (existing && existing.aporiaSource === "retrieval" &&
      existing.content === `${RELEVANT_CONTEXT_PREFIX}\n${JSON.stringify(relevant)}`) {
    relevantContextState.set(conversation, { key, items: relevant });
    return relevant;
  }
  removeRelevantContextMessages(conversation);
  if (relevant.length) {
    conversation.push({
      role: "system",
      aporiaSource: "retrieval",
      content: `${RELEVANT_CONTEXT_PREFIX}\n${JSON.stringify(relevant)}`,
    });
  }
  relevantContextState.set(conversation, { key, items: relevant });
  return relevant;
}

function parseRuleFrontmatter(content) {
  const value = String(content || "");
  if (!value.startsWith("---")) {
    return { paths: [], body: value };
  }
  const end = value.indexOf("\n---", 3);
  if (end < 0) return { paths: [], body: value };
  const header = value.slice(3, end).trim();
  const body = value.slice(end + 4).replace(/^\r?\n/, "");
  const paths = [];
  const inline = header.match(/^paths\s*:\s*\[(.*)\]\s*$/m);
  if (inline) {
    for (const item of inline[1].split(",")) {
      const path = item.trim().replace(/^['"]|['"]$/g, "");
      if (path) paths.push(path);
    }
  }
  const lines = header.split(/\r?\n/);
  let inPaths = false;
  for (const line of lines) {
    if (/^paths\s*:\s*$/.test(line.trim())) {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      const match = line.match(/^\s*-\s*(.+?)\s*$/);
      if (!match) {
        if (line.trim()) inPaths = false;
        continue;
      }
      paths.push(match[1].replace(/^['"]|['"]$/g, ""));
    }
  }
  return { paths: [...new Set(paths)], body };
}

function globToRegExp(pattern) {
  const normalized = String(pattern || "**/*").replace(/\\/g, "/");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        if (normalized[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 1;
        } else {
          source += ".*";
        }
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "i");
}

async function readInstructionFile(path) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.size > MAX_RULE_FILE_CHARS * 4) return "";
  return (await readFile(path, "utf8")).slice(0, MAX_RULE_FILE_CHARS);
}

async function scanRuleDirectory(workspaceRoot) {
  const root = join(workspaceRoot, ".aporiax", "rules");
  const output = [];
  async function visit(directory) {
    if (output.length >= MAX_RULE_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (output.length >= MAX_RULE_FILES) break;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const content = await readInstructionFile(fullPath);
        if (!content.trim()) continue;
        const parsed = parseRuleFrontmatter(content);
        output.push({
          source: relative(workspaceRoot, fullPath).replace(/\\/g, "/"),
          paths: parsed.paths,
          content: parsed.body,
        });
      }
    }
  }
  await visit(root);
  return output;
}

export async function loadProjectInstructionContext(workspaceRoot) {
  if (!workspaceRoot) {
    return {
      workspaceRoot: null,
      root: { content: "", files: [] },
      rules: [],
      loadedFiles: new Set(),
    };
  }
  const sections = [];
  const files = [];
  for (const name of INSTRUCTION_FILE_NAMES) {
    try {
      const content = await readInstructionFile(join(workspaceRoot, name));
      if (!content.trim()) continue;
      files.push(name);
      sections.push(`## ${name}\n${content}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const rules = await scanRuleDirectory(workspaceRoot);
  return {
    workspaceRoot,
    root: { content: sections.join("\n\n"), files },
    rules,
    loadedFiles: new Set(files),
  };
}

function ancestorDirectoriesForPath(requestedPath) {
  const normalized = normalizeRelativePath(requestedPath);
  let current = normalized;
  if (current === ".") return [];
  const directories = [];
  while (current && current !== ".") {
    directories.unshift(current);
    const parent = dirname(current).replace(/\\/g, "/");
    if (!parent || parent === current) break;
    current = parent;
  }
  return directories;
}

export async function resolveScopedInstructions(
  context,
  requestedPaths,
) {
  if (!context?.workspaceRoot) return { content: "", files: [] };
  const loadedFiles = new Set(context.loadedFiles);
  const sections = [];
  const files = [];
  const paths = [...new Set((requestedPaths || ["."]).map(normalizeRelativePath))];

  for (const requestedPath of paths) {
    for (const directory of ancestorDirectoriesForPath(requestedPath)) {
      for (const name of INSTRUCTION_FILE_NAMES) {
        const source = `${directory}/${name}`;
        if (loadedFiles.has(source)) continue;
        try {
          const content = await readInstructionFile(
            join(context.workspaceRoot, ...source.split("/")),
          );
          if (!content.trim()) continue;
          loadedFiles.add(source);
          files.push(source);
          sections.push(`## ${source}\n${content}`);
        } catch (error) {
          if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
            throw error;
          }
        }
      }
    }
    for (const rule of context.rules) {
      if (loadedFiles.has(rule.source)) continue;
      const matches =
        !rule.paths.length ||
        rule.paths.some((pattern) => globToRegExp(pattern).test(requestedPath));
      if (!matches) continue;
      loadedFiles.add(rule.source);
      files.push(rule.source);
      sections.push(`## ${rule.source}\n${rule.content}`);
    }
  }

  for (const source of loadedFiles) context.loadedFiles.add(source);
  return { content: sections.join("\n\n"), files };
}

function projectMemoryPath(baseDirectory, workspaceRoot) {
  const digest = createHash("sha256")
    .update(resolve(workspaceRoot).toLowerCase())
    .digest("hex")
    .slice(0, 24);
  return join(baseDirectory, `${digest}.json`);
}

function sanitizeMemoryFact(input) {
  const content = String(input?.content || "").replace(/\s+/g, " ").trim();
  const evidence = String(input?.evidence || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  if (!content || content.length > MAX_MEMORY_FACT_CHARS) {
    throw new Error(
      `Project memory content must be between 1 and ${MAX_MEMORY_FACT_CHARS} characters.`,
    );
  }
  if (
    /(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{16,}|authorization\s*:\s*bearer|api[_ -]?key\s*[=:]|secret\s*[=:]|private key-----)/i.test(
      `${content}\n${evidence}`,
    )
  ) {
    throw new Error("Secrets and credentials must not be stored in project memory.");
  }
  const categories = new Set([
    "architecture",
    "command",
    "convention",
    "debugging",
    "preference",
    "verification",
  ]);
  const category = categories.has(input?.category)
    ? input.category
    : "convention";
  return {
    category,
    content,
    evidence,
  };
}

export async function createProjectMemoryStore({
  baseDirectory,
  workspaceRoot,
}) {
  const memoryPath =
    baseDirectory && workspaceRoot
      ? projectMemoryPath(baseDirectory, workspaceRoot)
      : null;
  let data = {
    version: 1,
    workspace: workspaceRoot || "",
    updatedAt: null,
    facts: [],
  };
  if (memoryPath) {
    try {
      const parsed = JSON.parse(await readFile(memoryPath, "utf8"));
      if (Array.isArray(parsed?.facts)) {
        data = {
          ...data,
          ...parsed,
          facts: parsed.facts.slice(-MAX_MEMORY_FACTS),
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }

  const persist = async () => {
    if (!memoryPath) return;
    await mkdir(dirname(memoryPath), { recursive: true });
    await writeFile(memoryPath, JSON.stringify(data, null, 2), "utf8");
  };

  const remember = async (input) => {
    const fact = sanitizeMemoryFact(input);
    const key = `${fact.category}:${fact.content.toLowerCase()}`;
    const existing = data.facts.find(
      (item) => `${item.category}:${String(item.content).toLowerCase()}` === key,
    );
    const now = new Date().toISOString();
    if (existing) {
      existing.lastSeenAt = now;
      existing.occurrences = (existing.occurrences || 1) + 1;
      if (fact.evidence) existing.evidence = fact.evidence;
    } else {
      data.facts.push({
        id: createHash("sha256").update(key).digest("hex").slice(0, 16),
        ...fact,
        createdAt: now,
        lastSeenAt: now,
        occurrences: 1,
      });
      data.facts = data.facts.slice(-MAX_MEMORY_FACTS);
    }
    data.updatedAt = now;
    await persist();
    return existing || data.facts.at(-1);
  };

  return {
    get facts() {
      return [...data.facts];
    },
    path: memoryPath,
    retrieve(query, limit = 8) {
      return retrieveRelevantContext({
        query,
        memoryFacts: data.facts,
        limit,
      })
        .filter((item) => item.kind === "memory")
        .map((item) => item.value);
    },
    remember,
    async rememberSuccessfulCommand(command, cwd = ".") {
      if (!command) return null;
      return remember({
        category: "verification",
        content: `Verified command: ${command} (cwd: ${cwd || "."})`,
        evidence: "AporiaX observed a zero exit code during mandatory self-check.",
      });
    },
  };
}

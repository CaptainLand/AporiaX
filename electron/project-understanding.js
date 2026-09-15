import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink, realpath, stat } from "node:fs/promises";
import { withUnderstandingWriteLock } from "./understanding-write-lock.js";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

const STORE_VERSION = 1;
const MAX_FACTS = 320;
const MAX_REVISIONS = 80;
const MAX_FACT_CHARS = 1_600;
const MAX_SUMMARY_CHARS = 1_200;
const MAX_EVIDENCE_ITEMS = 12;
const MAX_EVIDENCE_CHARS = 600;
const MAX_CONTEXT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const writeQueues = new Map();

// Reload under a shared writer lock; never overwrite another run's newer state.
async function serializeStore(filePath, action, lockFile = true) {
  const key = filePath || action;
  const previous = writeQueues.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    if (!filePath || !lockFile) return action();
    await mkdir(dirname(filePath), { recursive: true });
    return withUnderstandingWriteLock(filePath, action);
  });
  writeQueues.set(key, pending);
  try { return await pending; }
  finally { if (writeQueues.get(key) === pending) writeQueues.delete(key); }
}

async function evidenceFingerprint(workspaceRoot, reference) {
  if (!workspaceRoot || !reference) return null;
  try {
    const root = await realpath(workspaceRoot);
    const target = await realpath(resolve(root, reference));
    const child = relative(root, target);
    if (isAbsolute(child) || child === ".." || child.startsWith("../") || child.startsWith("..\\")) return null;
    const info = await stat(target);
    if (!info.isFile() || info.size > 5_000_000) return null;
    return createHash("sha256").update(await readFile(target)).digest("hex");
  } catch { return null; }
}

const CATEGORIES = new Set([
  "architecture",
  "command",
  "convention",
  "decision",
  "module",
  "verification",
  "known_issue",
  "preference",
]);

const SECRET_PATTERN =
  /(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{16,}|authorization\s*:\s*bearer|api[_ -]?key\s*[=:]|secret\s*[=:]|private key-----)/i;

function projectDigest(workspaceRoot) {
  return createHash("sha256")
    .update(resolve(workspaceRoot).toLowerCase())
    .digest("hex")
    .slice(0, 24);
}

function understandingPath(baseDirectory, workspaceRoot) {
  return join(baseDirectory, `${projectDigest(workspaceRoot)}.json`);
}

function cleanText(value, maximum) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function assertNoSecrets(value) {
  if (SECRET_PATTERN.test(String(value || ""))) {
    throw new Error(
      "Secrets and credentials must not be stored in Project Understanding.",
    );
  }
}

function normalizeEvidence(input) {
  const values = Array.isArray(input) ? input : input ? [input] : [];
  return values.slice(0, MAX_EVIDENCE_ITEMS).map((item) => {
    const source =
      typeof item === "string"
        ? { type: "note", reference: item }
        : item || {};
    const type = ["file", "command", "test", "user", "note"].includes(
      source.type,
    )
      ? source.type
      : "note";
    const reference = cleanText(
      source.reference || source.path || source.command || "",
      MAX_EVIDENCE_CHARS,
    );
    const detail = cleanText(source.detail || "", MAX_EVIDENCE_CHARS);
    assertNoSecrets(`${reference}\n${detail}`);
    return { type, reference, detail };
  }).filter((item) => item.reference || item.detail);
}

function normalizeFact(input) {
  const content = cleanText(input?.content, MAX_FACT_CHARS);
  if (!content) {
    throw new Error("Project Understanding facts require content.");
  }
  assertNoSecrets(content);
  const confidence = Number(input?.confidence);
  return {
    category: CATEGORIES.has(input?.category)
      ? input.category
      : "convention",
    content,
    evidence: normalizeEvidence(input?.evidence),
    confidence: Number.isFinite(confidence)
      ? Math.min(1, Math.max(0, confidence))
      : 0.75,
  };
}

export function normalizeProjectUnderstandingCandidate(input) {
  return normalizeFact(input);
}

function factKey(fact) {
  return `${fact.category}:${fact.content.toLowerCase()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tokenize(value) {
  const text = String(value || "").toLowerCase();
  const tokens = new Set(text.match(/[a-z0-9_$.-]{2,}/g) || []);
  const cjk = [...text].filter((character) => /[\u3400-\u9fff]/.test(character));
  for (const character of cjk) tokens.add(character);
  for (let index = 0; index < cjk.length - 1; index += 1) {
    tokens.add(`${cjk[index]}${cjk[index + 1]}`);
  }
  return tokens;
}

function relevanceScore(fact, queryTokens) {
  if (!queryTokens.size) return fact.confidence || 0;
  const factTokens = tokenize(
    `${fact.category} ${fact.content} ${(fact.evidence || [])
      .map((item) => `${item.reference} ${item.detail}`)
      .join(" ")}`,
  );
  let overlap = 0;
  for (const token of queryTokens) {
    if (factTokens.has(token)) overlap += token.length > 1 ? 2 : 1;
  }
  if (!overlap) return 0;
  return overlap * 10 + (fact.confidence || 0) * 2 + Math.log2((fact.occurrences || 1) + 1);
}

function normalizeLoadedData(parsed, workspaceRoot) {
  const facts = Array.isArray(parsed?.facts)
    ? parsed.facts.slice(-MAX_FACTS)
    : [];
  const revisions = Array.isArray(parsed?.revisions)
    ? parsed.revisions.slice(-MAX_REVISIONS)
    : [];
  return {
    version: STORE_VERSION,
    workspace: workspaceRoot || parsed?.workspace || "",
    projectId: projectDigest(workspaceRoot || parsed?.workspace || "."),
    currentRevision: Number(parsed?.currentRevision) || 0,
    updatedAt: parsed?.updatedAt || null,
    settings: {
      useForContext: parsed?.settings?.useForContext === true,
      autoCurate: parsed?.settings?.autoCurate === true,
    },
    facts,
    revisions,
  };
}

function publicState(data) {
  return {
    version: data.version,
    workspace: data.workspace,
    projectId: data.projectId,
    currentRevision: data.currentRevision,
    updatedAt: data.updatedAt,
    settings: { ...data.settings },
    facts: clone(data.facts),
    revisions: data.revisions
      .slice()
      .reverse()
      .map(({ snapshot: _snapshot, ...revision }) => ({
        ...clone(revision),
        changes: (revision.changes || []).map((change) => {
          const fact = change.after || change.before || {};
          return {
            operation: change.operation,
            factId: change.factId,
            category: fact.category || null,
            content: String(fact.content || "").slice(0, 240),
          };
        }),
      })),
  };
}

export async function createProjectUnderstandingStore({
  baseDirectory,
  workspaceRoot,
}) {
  const filePath =
    baseDirectory && workspaceRoot
      ? understandingPath(baseDirectory, workspaceRoot)
      : null;
  let data = normalizeLoadedData(null, workspaceRoot || "");

  const refresh = async () => {
    if (!filePath) return;
    try {
      data = normalizeLoadedData(
        JSON.parse(await readFile(filePath, "utf8")),
        workspaceRoot,
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
  await refresh();

  const persist = async () => {
    if (!filePath) return;
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(data, null, 2), "utf8");
      await rename(temporary, filePath);
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  };

  const appendRevision = async ({
    taskId = "",
    runId = "",
    summary,
    source = "agent-curator",
    changes = [],
    facts,
    revertedFrom = null,
  }) => {
    const now = new Date().toISOString();
    const number = data.currentRevision + 1;
    const revisionId = `u-${String(number).padStart(4, "0")}-${createHash("sha256")
      .update(`${now}:${taskId}:${summary}`)
      .digest("hex")
      .slice(0, 8)}`;
    data.facts = clone(facts).slice(-MAX_FACTS);
    data.currentRevision = number;
    data.updatedAt = now;
    data.revisions.push({
      id: revisionId,
      number,
      parentRevision: number - 1,
      taskId: cleanText(taskId, 160),
      runId: cleanText(runId, 160),
      source,
      summary: cleanText(summary, MAX_SUMMARY_CHARS) || "Updated project understanding",
      createdAt: now,
      revertedFrom,
      changes: clone(changes).slice(0, 40),
      changeCount: changes.length,
      factCount: data.facts.length,
      snapshot: clone(data.facts),
    });
    data.revisions = data.revisions.slice(-MAX_REVISIONS);
    await persist();
    return data.revisions.at(-1);
  };

  const store = {
    path: filePath,
    snapshot() {
      return publicState(data);
    },
    refresh: () => serializeStore(filePath, refresh, false),
    async setSettings(patch = {}) {
      return serializeStore(filePath, async () => {
        await refresh();
        for (const key of ["useForContext", "autoCurate"]) {
          if (typeof patch[key] === "boolean") data.settings[key] = patch[key];
        }
        await persist();
        return publicState(data);
      });
    },
    async contextFacts(query, limit = 8) {
      await store.refresh();
      if (!data.settings.useForContext || !String(query || "").trim()) return [];
      const valid = [];
      let chars = 0;
      for (const fact of store.retrieve(query, 40)) {
        const confirmed = Date.parse(fact.lastConfirmedAt || "");
        if (!Number.isFinite(confirmed) || Date.now() - confirmed > MAX_CONTEXT_AGE_MS) continue;
        const files = (fact.evidence || []).filter((item) => item.type === "file");
        if (files.length && !(await Promise.all(files.map(async (item) =>
          Boolean(item.fingerprint) && item.fingerprint === await evidenceFingerprint(workspaceRoot, item.reference)
        ))).every(Boolean)) continue;
        const size = JSON.stringify(fact).length;
        if (chars + size > 8_000) continue;
        valid.push(clone(fact)); chars += size;
        if (valid.length >= Math.max(1, Math.min(8, limit))) break;
      }
      return valid;
    },
    retrieve(query, limit = 12) {
      const queryTokens = tokenize(query);
      return data.facts
        .map((fact) => ({ fact, score: relevanceScore(fact, queryTokens) }))
        .filter((item) => queryTokens.size > 0 && item.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.max(1, Math.min(40, limit)))
        .map((item) => clone(item.fact));
    },
    async commit({
      taskId = "",
      runId = "",
      summary = "",
      source = "agent-curator",
      changes = [],
    }) {
      return serializeStore(filePath, async () => {
      await refresh();
      const nextFacts = clone(data.facts);
      const applied = [];
      const now = new Date().toISOString();

      for (const rawChange of (Array.isArray(changes) ? changes : []).slice(0, MAX_FACTS)) {
        const operation = rawChange?.operation === "remove" ? "remove" : "upsert";
        if (operation === "remove") {
          const index = nextFacts.findIndex(
            (fact) => fact.id === String(rawChange?.factId || ""),
          );
          if (index < 0) continue;
          const [removed] = nextFacts.splice(index, 1);
          applied.push({ operation, factId: removed.id, before: removed });
          continue;
        }

        const normalized = normalizeFact(rawChange);
        for (const evidence of normalized.evidence) {
          if (evidence.type === "file") evidence.fingerprint = await evidenceFingerprint(workspaceRoot, evidence.reference);
        }
        if (normalized.confidence < 0.55) continue;
        const requestedId = String(rawChange?.factId || "");
        const index = nextFacts.findIndex(
          (fact) =>
            (requestedId && fact.id === requestedId) ||
            factKey(fact) === factKey(normalized),
        );
        if (index >= 0) {
          const before = clone(nextFacts[index]);
          const evidence = [
            ...(nextFacts[index].evidence || []).filter((old) => !normalized.evidence.some((item) => item.type === old.type && item.reference === old.reference)),
            ...normalized.evidence,
          ].filter(
            (item, itemIndex, all) =>
              all.findIndex(
                (candidate) =>
                  candidate.type === item.type &&
                  candidate.reference === item.reference &&
                  candidate.detail === item.detail && candidate.fingerprint === item.fingerprint,
              ) === itemIndex,
          ).slice(-MAX_EVIDENCE_ITEMS);
          nextFacts[index] = {
            ...nextFacts[index],
            ...normalized,
            evidence,
            lastConfirmedAt: now,
            occurrences: (nextFacts[index].occurrences || 1) + 1,
            updatedByTask: cleanText(taskId, 160),
          };
          applied.push({
            operation: "update",
            factId: nextFacts[index].id,
            before,
            after: clone(nextFacts[index]),
          });
        } else {
          const id = createHash("sha256")
            .update(factKey(normalized))
            .digest("hex")
            .slice(0, 16);
          const fact = {
            id,
            ...normalized,
            createdAt: now,
            lastConfirmedAt: now,
            occurrences: 1,
            createdByTask: cleanText(taskId, 160),
            updatedByTask: cleanText(taskId, 160),
          };
          nextFacts.push(fact);
          applied.push({ operation: "add", factId: id, after: clone(fact) });
        }
      }

      if (!applied.length) {
        return { committed: false, revision: null, state: publicState(data) };
      }
      const revision = await appendRevision({
        taskId,
        runId,
        summary,
        source,
        changes: applied,
        facts: nextFacts,
      });
      return { committed: true, revision: clone(revision), state: publicState(data) };
      });
    },
    async revertTo(revisionId, { taskId = "", runId = "" } = {}) {
      return serializeStore(filePath, async () => {
      await refresh();
      const target = data.revisions.find(
        (revision) =>
          revision.id === revisionId || revision.number === Number(revisionId),
      );
      if (!target?.snapshot) {
        throw new Error("The selected Understanding revision is unavailable.");
      }
      const beforeById = new Map(data.facts.map((fact) => [fact.id, fact]));
      const afterById = new Map(target.snapshot.map((fact) => [fact.id, fact]));
      const changes = [];
      for (const [id, before] of beforeById) {
        if (!afterById.has(id)) changes.push({ operation: "remove", factId: id, before });
      }
      for (const [id, after] of afterById) {
        const before = beforeById.get(id);
        if (!before) changes.push({ operation: "add", factId: id, after });
        else if (JSON.stringify(before) !== JSON.stringify(after)) {
          changes.push({ operation: "update", factId: id, before, after });
        }
      }
      const revision = await appendRevision({
        taskId,
        runId,
        source: "user-revert",
        summary: `Restored Project Understanding from revision ${target.number}`,
        changes,
        facts: target.snapshot,
        revertedFrom: target.id,
      });
      return { committed: true, revision: clone(revision), state: publicState(data) };
      });
    },
  };
  return store;
}

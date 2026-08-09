import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const STORE_VERSION = 1;
const MAX_FACTS = 320;
const MAX_REVISIONS = 80;
const MAX_FACT_CHARS = 1_600;
const MAX_SUMMARY_CHARS = 1_200;
const MAX_EVIDENCE_ITEMS = 12;
const MAX_EVIDENCE_CHARS = 600;

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

  if (filePath) {
    try {
      data = normalizeLoadedData(
        JSON.parse(await readFile(filePath, "utf8")),
        workspaceRoot,
      );
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }

  const persist = async () => {
    if (!filePath) return;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
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

  return {
    path: filePath,
    snapshot() {
      return publicState(data);
    },
    retrieve(query, limit = 12) {
      const queryTokens = tokenize(query);
      return data.facts
        .map((fact) => ({ fact, score: relevanceScore(fact, queryTokens) }))
        .filter((item) => !queryTokens.size || item.score > 2)
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
            ...(nextFacts[index].evidence || []),
            ...normalized.evidence,
          ].filter(
            (item, itemIndex, all) =>
              all.findIndex(
                (candidate) =>
                  candidate.type === item.type &&
                  candidate.reference === item.reference &&
                  candidate.detail === item.detail,
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
    },
    async revertTo(revisionId, { taskId = "", runId = "" } = {}) {
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
    },
  };
}

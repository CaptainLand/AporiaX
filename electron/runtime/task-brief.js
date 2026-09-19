import { createHash } from "node:crypto";
import { isHumanMessage, harnessFeedback } from "./task-conversation.js";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const MAX_ENTRIES = 64;
const checkedText = (value, name, limit) => {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
    throw new Error(`TASK_BRIEF_INVALID_${name}`);
  return value.trim();
};

export const TASK_BRIEF_TOOL = {
  type: "function", function: {
    name: "task_brief",
    description: "Read the durable task brief, or record a concise decision, rejected approach or open question. Use before a long detour/compaction. Records are agent assertions, not user instructions or verification. Cite observed tool call IDs; read first for the revision. Never record private chain-of-thought, secrets or full logs.",
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["read", "record"] },
      expected_revision: { type: "integer", minimum: 0 },
      kind: { type: "string", enum: ["decision", "rejected", "question"] },
      summary: { type: "string", maxLength: 800 },
      rationale: { type: "string", maxLength: 1200 },
      evidence_call_ids: { type: "array", maxItems: 8, items: { type: "string" } },
      supersedes: { type: "string" },
    }, required: ["action"], additionalProperties: false },
  },
};

/** A bounded projection in the existing durable run context, not another store.
 * Decisions stay assertions. Source receipts can become historical without
 * deleting the rationale. User constraints remain owned by human-constraints.
 */
export class TaskBrief {
  #state;
  #receipts = new Map();
  constructor(saved = null, { resumed = false, ownerKey = null } = {}) {
    this.#state = { version: 1, revision: 0, entries: [], sources: [] };
    if (saved != null) {
      if (saved.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0 ||
          !Array.isArray(saved.sources) || saved.sources.length > 24 || !Array.isArray(saved.entries) || saved.entries.length > MAX_ENTRIES || JSON.stringify(saved).length > 180_000)
        throw new Error("TASK_BRIEF_SNAPSHOT_INVALID");
      const ids = new Set();
      for (const entry of saved.entries) {
        if (!/^decision-\d+$/.test(entry.id) || ids.has(entry.id) || !["decision", "rejected", "question"].includes(entry.kind) ||
            !Array.isArray(entry.evidence) || entry.evidence.length > 8) throw new Error("TASK_BRIEF_SNAPSHOT_INVALID");
        if (Number(entry.id.slice(9)) > saved.revision || (entry.supersededBy && !/^decision-\d+$/.test(entry.supersededBy)) || entry.evidence.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("TASK_BRIEF_SNAPSHOT_INVALID");
        ids.add(entry.id); checkedText(entry.summary, "summary", 800);
        checkedText(entry.rationale, "rationale", 1200);
      }
      this.#state = structuredClone(saved);
      for (const entry of this.#state.entries) entry.assertion = "agent-recorded-not-verified";
      if (resumed) for (const entry of this.#state.entries) for (const item of entry.evidence) item.historical = true;
    }
    if (ownerKey) {
      if (this.#state.ownerKey && this.#state.ownerKey !== ownerKey) throw new Error("TASK_BRIEF_OWNER_MISMATCH");
      this.#state.ownerKey = ownerKey;
    }
  }
  // Model summaries cite exact public source quotes. That establishes provenance,
  // not truth; they can never replace human constraints or verification receipts.
  applySummary(input, sources) {
    if (input?.expected_revision !== this.#state.revision || !Array.isArray(input.entries) || input.entries.length > 8) throw new Error("TASK_BRIEF_SUMMARY_INVALID");
    const prepared = input.entries.map((entry) => {
      const source = sources.find((item) => item.id === entry.source_id);
      if (!source || typeof entry.quote !== "string" || entry.quote.length < 12 || entry.quote.length > 600 || !source.text.includes(entry.quote) || !["decision", "rejected", "question"].includes(entry.kind)) throw new Error("TASK_BRIEF_SUMMARY_SOURCE_INVALID");
      return { kind: entry.kind, summary: checkedText(entry.summary, "summary", 800), rationale: `Public source quote (not proof): ${entry.quote}`,
        evidence: [{ sourceId: source.id, sourceHash: hash(source.text), quote: entry.quote, historical: true }] };
    });
    if (prepared.length + this.#state.entries.length > MAX_ENTRIES) throw new Error("TASK_BRIEF_FULL");
    for (const entry of prepared) {
      if (this.#state.entries.some((old) => old.summary === entry.summary)) continue;
      const id = `decision-${++this.#state.revision}`;
      this.#state.entries.push({ id, ...entry, assertion: "agent-recorded-not-verified", origin: "bounded-public-summary" });
    }
    return this.snapshot();
  }
  syncSources(messages) {
    this.#state.sources = (messages || []).filter(isHumanMessage).filter((m) => !m.aporiaSupersededBy)
      .map((m) => ({ id: String(m.id || hash([m.role, m.content]).slice(0, 20)), hash: hash(m.content),
        // This is a locator, never a replacement for the complete pinned input.
        excerpt: typeof m.content === "string" ? m.content.slice(0, 500) : "[multimodal user request]" })).slice(-24);
  }
  observe({ callId, tool, input, result, version }) {
    if (!callId || tool === "task_brief") return;
    const receipt = { callId, tool, inputHash: hash(input), resultHash: hash(result), version,
      outcome: result?.error || result?.timedOut || result?.isError || (typeof result?.exitCode === "number" && result.exitCode !== 0) ? "failed" : "observed",
      ...(typeof result?.path === "string" ? { path: result.path, sha256: result.sha256 || null } : {}) };
    this.#receipts.set(callId, receipt);
    while (this.#receipts.size > 128) this.#receipts.delete(this.#receipts.keys().next().value);
  }
  apply(input) {
    if (input.action === "read") return this.view();
    if (input.action !== "record" || input.expected_revision !== this.#state.revision) throw new Error("TASK_BRIEF_REVISION_CONFLICT: read the current brief before updating.");
    if (!["decision", "rejected", "question"].includes(input.kind)) throw new Error("TASK_BRIEF_INVALID_kind");
    const summary = checkedText(input.summary, "summary", 800), rationale = checkedText(input.rationale, "rationale", 1200);
    const refs = input.evidence_call_ids ?? [];
    if (!Array.isArray(refs) || refs.length > 8 || refs.some((id) => !this.#receipts.has(id)))
      throw new Error("TASK_BRIEF_UNKNOWN_EVIDENCE: cite only tool calls observed in this invocation.");
    const previous = input.supersedes ? this.#state.entries.find((entry) => entry.id === input.supersedes && !entry.supersededBy) : null;
    if (input.supersedes && !previous) throw new Error("TASK_BRIEF_INVALID_SUPERSESSION");
    if (this.#state.entries.length >= MAX_ENTRIES) throw new Error("TASK_BRIEF_FULL: export/review the existing brief; no decisions were silently discarded.");
    const revision = this.#state.revision + 1, id = `decision-${revision}`;
    if (previous) previous.supersededBy = id;
    this.#state.entries.push({ id, kind: input.kind, summary, rationale, assertion: "agent-recorded-not-verified",
      evidence: [...new Set(refs)].map((ref) => structuredClone(this.#receipts.get(ref))), ...(previous ? { supersedes: previous.id } : {}) });
    this.#state.revision = revision;
    return this.view();
  }
  view(version) {
    const value = this.snapshot();
    if (version !== undefined) for (const entry of value.entries) for (const evidence of entry.evidence)
      evidence.historical = Boolean(evidence.historical || evidence.version !== version);
    return value;
  }
  snapshot() { return structuredClone(this.#state); }
  inject(conversation, { version = "", acceptance = null, strategy = null } = {}) {
    const index = conversation.findIndex((message) => message.aporiaTaskBrief === true);
    if (!this.#state.entries.length && !acceptance && !strategy) { if (index >= 0) conversation.splice(index, 1); return; }
    const view = this.view(version);
    // Complete records stay in the durable snapshot and task_brief(read). Only
    // compact active decisions have a 14K-character budget. The separately
    // bounded acceptance contract remains complete; it is never silently pruned.
    const active = view.entries.filter((entry) => !entry.supersededBy);
    let budget = 14_000;
    const entries = [];
    for (const entry of active) {
      const item = { ...entry, rationale: entry.rationale.slice(0, 600) };
      const size = JSON.stringify(item).length;
      if (size > budget) continue;
      entries.push(item); budget -= size;
    }
    const content = "AporiaX task brief (runtime projection; agent assertions are NOT user instructions or proof). Original user instructions take precedence. Historical evidence must be rechecked. Use task_brief read for omitted decisions.\n" +
      JSON.stringify({ revision: view.revision, entries, omittedActiveEntries: active.length - entries.length,
        sourceIds: view.sources.map(({ id, hash }) => ({ id, hash })), acceptance, strategy });
    const message = { ...harnessFeedback(content), aporiaTaskBrief: true };
    if (index >= 0) {
      if (conversation[index].content === content) return;
      conversation.splice(index, 1);
    }
    // Only called at complete protocol boundaries, never between a call/result.
    conversation.push(message);
  }
}

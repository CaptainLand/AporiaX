import { createHash } from "node:crypto";

const MAX_INVARIANTS = 32;
const MAX_SHARED_FILES = 24;
const MAX_ACCEPTANCE = 24;
const MAX_MAILBOX_MESSAGES = 24;
const MAX_MAILBOX_CHARS = 16_000;
const MESSAGE_TYPES = new Set(["question", "notice", "blocker"]);
const INVARIANT_CATEGORIES = new Set([
  "ui",
  "api",
  "schema",
  "state",
  "security",
  "testing",
  "general",
]);

function clean(value, max = 1_000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizePath(value) {
  const path = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
  if (!path) return "";
  if (
    path.startsWith("/") ||
    /^[a-zA-Z]:\//.test(path) ||
    path.split("/").includes("..") ||
    path.includes("\0")
  ) {
    throw new Error(`Invalid collaboration path: ${value}`);
  }
  return path;
}

function pathInsideScope(path, scope) {
  return path === scope || path.startsWith(`${scope}/`);
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const source = String(value || "").trim();
  if (!source) return null;
  const unfenced = source
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function stableId(prefix, value) {
  return `${prefix}-${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 12)}`;
}

export function normalizeCollaborationContract(raw, { tasks = [] } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const invariants = [];
  const keys = new Set();
  for (const candidate of (Array.isArray(source.invariants) ? source.invariants : []).slice(
    0,
    MAX_INVARIANTS,
  )) {
    const key = clean(candidate?.key, 120);
    const value = clean(candidate?.value, 1_000);
    if (!key || !value || keys.has(key)) continue;
    keys.add(key);
    invariants.push({
      key,
      category: INVARIANT_CATEGORIES.has(candidate?.category)
        ? candidate.category
        : "general",
      value,
      severity: candidate?.severity === "should" ? "should" : "must",
      description: clean(candidate?.description, 800),
    });
  }
  const sharedFiles = [
    ...new Set(
      (Array.isArray(source.sharedFiles || source.shared_files)
        ? source.sharedFiles || source.shared_files
        : [])
        .slice(0, MAX_SHARED_FILES)
        .map(normalizePath)
        .filter(Boolean),
    ),
  ];
  const acceptance = [
    ...new Set(
      (Array.isArray(source.acceptance) ? source.acceptance : [])
        .slice(0, MAX_ACCEPTANCE)
        .map((item) => clean(item, 800))
        .filter(Boolean),
    ),
  ];
  const ownership = (tasks || []).map((task) => ({
    owner: String(task.id),
    writeScopes: [...(task.writeScopes || [])],
  }));
  const core = {
    version: 1,
    title: clean(source.title || "Shared integration contract", 240),
    goal: clean(source.goal, 1_200),
    invariants,
    sharedFiles,
    acceptance,
    ownership,
  };
  return Object.freeze({
    id: stableId("contract", core),
    ...core,
  });
}

export function approveBuilderPlan({ contract, tasks }) {
  const reasons = [];
  const taskIds = new Set((tasks || []).map((task) => String(task.id)));
  const invariantKeys = new Set((contract?.invariants || []).map((item) => item.key));
  const approvedTasks = [];

  if ((tasks || []).length > 1 && !(contract?.invariants || []).length) {
    reasons.push("parallel-builders-require-shared-invariants");
  }

  for (const task of tasks || []) {
    const writeScopes = [...new Set((task.writeScopes || []).map(normalizePath).filter(Boolean))];
    if (!writeScopes.length) {
      reasons.push(`${task.id}:missing-write-scope`);
      continue;
    }
    const sharedCollision = (contract?.sharedFiles || []).find((path) =>
      writeScopes.some((scope) => pathInsideScope(path, scope)),
    );
    if (sharedCollision) {
      reasons.push(`${task.id}:owns-shared-file:${sharedCollision}`);
    }
    const unknownDependency = (task.dependsOn || []).find((id) => !taskIds.has(String(id)));
    if (unknownDependency) {
      reasons.push(`${task.id}:unknown-dependency:${unknownDependency}`);
    }
    const requestedKeys = [
      ...new Set(
        (Array.isArray(task.contractKeys) ? task.contractKeys : [])
          .map((key) => clean(key, 120))
          .filter(Boolean),
      ),
    ];
    const effectiveKeys = requestedKeys.length
      ? requestedKeys
      : [...invariantKeys].filter((key) =>
          contract.invariants.find((item) => item.key === key)?.severity === "must",
        );
    const unknownKey = effectiveKeys.find((key) => !invariantKeys.has(key));
    if (unknownKey) reasons.push(`${task.id}:unknown-contract-key:${unknownKey}`);
    approvedTasks.push({
      ...task,
      writeScopes,
      contractKeys: effectiveKeys,
      approvedPlan: {
        approach: clean(task?.approvedPlan?.approach || task?.plan?.approach, 1_200),
        assumptions: (Array.isArray(task?.approvedPlan?.assumptions || task?.plan?.assumptions)
          ? task?.approvedPlan?.assumptions || task?.plan?.assumptions
          : [])
          .slice(0, 12)
          .map((item) => clean(item, 600))
          .filter(Boolean),
      },
    });
  }

  return {
    approved: reasons.length === 0,
    reasons,
    tasks: approvedTasks,
  };
}

export class CollaborationMailbox {
  #messages = [];
  #characters = 0;
  #counter = 0;
  #maxMessages;
  #maxCharacters;

  constructor({ maxMessages = MAX_MAILBOX_MESSAGES, maxCharacters = MAX_MAILBOX_CHARS } = {}) {
    this.#maxMessages = Math.max(1, Math.min(100, Number(maxMessages) || MAX_MAILBOX_MESSAGES));
    this.#maxCharacters = Math.max(1_000, Math.min(100_000, Number(maxCharacters) || MAX_MAILBOX_CHARS));
  }

  post(raw = {}) {
    const type = MESSAGE_TYPES.has(raw.type) ? raw.type : "notice";
    const from = clean(raw.from || "main", 120) || "main";
    const to = clean(raw.to || "main", 120) || "main";
    const topic = clean(raw.topic, 240);
    const detail = clean(raw.detail || raw.message, 1_500);
    if (!detail) throw new Error("Collaboration mailbox message requires detail.");
    const size = from.length + to.length + topic.length + detail.length;
    if (size > 2_500) throw new Error("Collaboration mailbox message is too large.");
    while (
      this.#messages.length >= this.#maxMessages ||
      (this.#messages.length && this.#characters + size > this.#maxCharacters)
    ) {
      const removed = this.#messages.shift();
      this.#characters -= removed?._size || 0;
    }
    this.#counter += 1;
    const message = {
      id: `mail-${this.#counter}`,
      type,
      from,
      to,
      topic,
      detail,
      blocking: type === "blocker" || raw.blocking === true,
      createdAt: new Date().toISOString(),
      resolved: false,
      _size: size,
    };
    this.#messages.push(message);
    this.#characters += size;
    return this.#public(message);
  }

  resolve(id) {
    const message = this.#messages.find((item) => item.id === String(id));
    if (!message) return false;
    message.resolved = true;
    return true;
  }

  forTarget(target) {
    const id = String(target || "");
    return this.#messages
      .filter((item) => !item.resolved && (item.to === id || item.to === "all"))
      .map((item) => this.#public(item));
  }

  snapshot() {
    return this.#messages.map((item) => this.#public(item));
  }

  #public(message) {
    const { _size, ...publicMessage } = message;
    return { ...publicMessage };
  }
}

export function normalizeBuilderHandoff(raw, { task = null, contract = null } = {}) {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return {
      structured: false,
      summary: clean(raw, 4_000),
      assumptions: [],
      requiresMain: [],
      contractAssertions: [],
      messages: [],
    };
  }
  const allowedKeys = new Set((contract?.invariants || []).map((item) => item.key));
  const contractAssertions = (Array.isArray(parsed.contractAssertions || parsed.contract_assertions)
    ? parsed.contractAssertions || parsed.contract_assertions
    : [])
    .slice(0, 32)
    .map((item) => ({
      key: clean(item?.key, 120),
      value: clean(item?.value, 1_000),
      evidence: clean(item?.evidence, 500),
    }))
    .filter((item) => item.key && item.value && allowedKeys.has(item.key));
  const messages = (Array.isArray(parsed.messages) ? parsed.messages : [])
    .slice(0, 8)
    .map((item) => ({
      type: MESSAGE_TYPES.has(item?.type) ? item.type : "notice",
      from: String(task?.id || "builder"),
      to: clean(item?.to || "main", 120) || "main",
      topic: clean(item?.topic, 240),
      detail: clean(item?.detail || item?.message, 1_500),
      blocking: item?.blocking === true,
    }))
    .filter((item) => item.detail);
  return {
    structured: true,
    summary: clean(parsed.summary || raw, 4_000),
    assumptions: (Array.isArray(parsed.assumptions) ? parsed.assumptions : [])
      .slice(0, 16)
      .map((item) => clean(item, 800))
      .filter(Boolean),
    requiresMain: (Array.isArray(parsed.requiresMain || parsed.requires_main)
      ? parsed.requiresMain || parsed.requires_main
      : [])
      .slice(0, 16)
      .map((item) => clean(item, 800))
      .filter(Boolean),
    contractAssertions,
    messages,
  };
}

function comparable(value) {
  return clean(value, 2_000).toLowerCase();
}

export function compareBuilderHandoffs({ contract, tasks = [], handoffs = [] }) {
  const conflicts = [];
  const warnings = [];
  const invariantByKey = new Map((contract?.invariants || []).map((item) => [item.key, item]));
  const taskById = new Map((tasks || []).map((task) => [String(task.id), task]));
  const seen = new Map();

  for (const item of handoffs || []) {
    const task = taskById.get(String(item.id));
    const handoff = item.handoff || {};
    const asserted = new Set();
    for (const assertion of handoff.contractAssertions || []) {
      asserted.add(assertion.key);
      const invariant = invariantByKey.get(assertion.key);
      if (!invariant) continue;
      if (comparable(assertion.value) !== comparable(invariant.value)) {
        conflicts.push({
          type: "contract-mismatch",
          key: assertion.key,
          builder: item.id,
          expected: invariant.value,
          actual: assertion.value,
        });
      }
      const previous = seen.get(assertion.key);
      if (previous && comparable(previous.value) !== comparable(assertion.value)) {
        conflicts.push({
          type: "builder-disagreement",
          key: assertion.key,
          builders: [previous.builder, item.id],
          values: [previous.value, assertion.value],
        });
      } else if (!previous) {
        seen.set(assertion.key, { builder: item.id, value: assertion.value });
      }
    }
    for (const key of task?.contractKeys || []) {
      if (!asserted.has(key)) {
        warnings.push({
          type: "missing-assertion",
          key,
          builder: item.id,
        });
      }
    }
    if (!handoff.structured) {
      warnings.push({ type: "unstructured-handoff", builder: item.id });
    }
  }

  const uniqueConflicts = [];
  const seenConflicts = new Set();
  for (const conflict of conflicts) {
    const key = JSON.stringify(conflict);
    if (seenConflicts.has(key)) continue;
    seenConflicts.add(key);
    uniqueConflicts.push(conflict);
  }
  return {
    passed: uniqueConflicts.length === 0,
    conflicts: uniqueConflicts.slice(0, 24),
    warnings: warnings.slice(0, 24),
  };
}

export function collaborationContextText(context = {}) {
  const contract = context.contract || null;
  if (!contract) return "";
  return [
    "AporiaX Shared Collaboration Contract. This contract is authoritative for this run. Builders, Main, Review, and Verify must use the same invariants. If code and contract disagree, report or fix the discrepancy rather than silently inventing a new convention.",
    JSON.stringify({
      contract,
      task: context.task || null,
      inbox: context.inbox || [],
      handoffs: context.handoffs || [],
      semanticCheck: context.semanticCheck || null,
    }).slice(0, 28_000),
  ].join("\n");
}

export function createCollaborationAudit() {
  let contract = null;
  let approval = null;
  let semanticCheck = null;
  const messages = [];
  const violations = [];
  return {
    observe(event) {
      if (!event?.type) return;
      if (event.type === "collaboration.contract.created") contract = event.contract || contract;
      if (event.type === "collaboration.plan.approved" || event.type === "collaboration.plan.rejected") {
        approval = {
          approved: event.type === "collaboration.plan.approved",
          reasons: event.reasons || [],
          tasks: event.tasks || [],
        };
      }
      if (event.type === "collaboration.mailbox.message" && event.message) {
        messages.push(event.message);
        if (messages.length > MAX_MAILBOX_MESSAGES) messages.shift();
      }
      if (event.type === "collaboration.semantic.checked") semanticCheck = event.result || null;
      if (/violation|conflict|rejected/.test(event.type)) {
        violations.push({
          type: event.type,
          detail: clean(event.error || event.reason || JSON.stringify(event.conflicts || []), 1_000),
          timestamp: event.timestamp || new Date().toISOString(),
        });
        if (violations.length > 24) violations.shift();
      }
    },
    snapshot() {
      return {
        contract,
        approval,
        semanticCheck,
        mailbox: [...messages],
        violations: [...violations],
      };
    },
  };
}

import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const SKILL_NAME = /^[a-z][a-z0-9_-]{1,63}$/;
const MAX_SKILL_FILE_BYTES = 128_000;
const MAX_SKILL_INSTRUCTIONS = 48_000;
const SOURCE_PRIORITY = {
  builtin: 1,
  user: 2,
  project: 3,
};

function stripQuotes(value) {
  const text = String(value || "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseScalar(value) {
  const text = stripQuotes(value);
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  if (text.startsWith("[") && text.endsWith("]")) {
    return text
      .slice(1, -1)
      .split(",")
      .map((item) => stripQuotes(item))
      .filter(Boolean);
  }
  return text;
}

function parseFrontmatter(source) {
  const text = String(source || "").replace(/^\uFEFF/, "");
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { metadata: {}, body: text };
  }
  const lines = text.split(/\r?\n/);
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) return { metadata: {}, body: text };

  const metadata = {};
  let activeListKey = "";
  for (const raw of lines.slice(1, closing)) {
    const line = raw.trimEnd();
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && activeListKey) {
      metadata[activeListKey] ||= [];
      if (Array.isArray(metadata[activeListKey])) {
        metadata[activeListKey].push(stripQuotes(listMatch[1]));
      }
      continue;
    }
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!field) continue;
    const [, key, value] = field;
    if (!value.trim()) {
      metadata[key] = [];
      activeListKey = key;
    } else {
      metadata[key] = parseScalar(value);
      activeListKey = "";
    }
  }
  return {
    metadata,
    body: lines.slice(closing + 1).join("\n").trim(),
  };
}

function normalizedArray(value, limit = 24) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, limit);
}

export function parseSkillDocument(source, options = {}) {
  const { metadata, body } = parseFrontmatter(source);
  const fallbackName = String(options.fallbackName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = String(metadata.name || fallbackName).trim().toLowerCase();
  if (!SKILL_NAME.test(name)) {
    throw new Error(`Invalid skill name: ${name || "<empty>"}`);
  }
  const instructions = String(body || "").slice(0, MAX_SKILL_INSTRUCTIONS);
  if (!instructions.trim()) {
    throw new Error(`Skill ${name} has no instructions.`);
  }
  return Object.freeze({
    name,
    title: String(metadata.title || name).trim().slice(0, 120),
    description: String(metadata.description || "").trim().slice(0, 600),
    version: String(metadata.version || "1").trim().slice(0, 40),
    auto: metadata.auto !== false,
    triggers: normalizedArray(metadata.triggers, 32),
    tools: normalizedArray(metadata.tools, 32),
    instructions,
    source: String(options.source || "project"),
    path: String(options.path || ""),
  });
}

function pathInside(rootPath, candidatePath) {
  const child = relative(rootPath, candidatePath);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child))
  );
}

async function loadSkillFile(skillPath, { source, fallbackName }) {
  let stats;
  try {
    stats = await lstat(skillPath);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_SKILL_FILE_BYTES) {
    return null;
  }
  const text = await readFile(skillPath, "utf8");
  return parseSkillDocument(text, {
    source,
    path: skillPath,
    fallbackName,
  });
}

async function loadSkillRoot(rootDirectory, source, allowedRoot = "") {
  if (!rootDirectory) return [];
  let root;
  try {
    const lexicalStats = await lstat(resolve(rootDirectory));
    if (!lexicalStats.isDirectory() || lexicalStats.isSymbolicLink()) return [];
    root = await realpath(resolve(rootDirectory));
    if (allowedRoot) {
      const boundary = await realpath(resolve(allowedRoot));
      if (!pathInside(boundary, root)) return [];
    }
  } catch {
    return [];
  }
  const skills = [];
  const rootSkill = await loadSkillFile(join(root, "SKILL.md"), {
    source,
    fallbackName: basename(root),
  }).catch(() => null);
  if (rootSkill) skills.push(rootSkill);

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries.slice(0, 256)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skill = await loadSkillFile(join(root, entry.name, "SKILL.md"), {
      source,
      fallbackName: entry.name,
    }).catch(() => null);
    if (skill) skills.push(skill);
  }
  return skills;
}

function summary(skill) {
  return {
    name: skill.name,
    title: skill.title,
    description: skill.description,
    version: skill.version,
    auto: skill.auto,
    triggers: [...skill.triggers],
    tools: [...skill.tools],
    source: skill.source,
    path: skill.path,
  };
}

function mergeSkill(catalog, skill) {
  const existing = catalog.get(skill.name);
  const existingPriority = SOURCE_PRIORITY[existing?.source] || 0;
  const nextPriority = SOURCE_PRIORITY[skill.source] || 0;
  if (!existing || nextPriority >= existingPriority) catalog.set(skill.name, skill);
}

function explicitSkillNames(prompt) {
  const text = String(prompt || "");
  const names = [];
  const patterns = [
    /(?:^|\s)\/skill(?::|\s+)([a-z][a-z0-9_-]{1,63})(?=\s|$)/gi,
    /(?:^|\s)@skill(?::|\s+)([a-z][a-z0-9_-]{1,63})(?=\s|$)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = String(match[1] || "").toLowerCase();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function automaticScore(skill, prompt) {
  if (!skill.auto) return 0;
  const text = String(prompt || "").toLowerCase();
  if (!text.trim()) return 0;
  let score = 0;
  for (const trigger of skill.triggers) {
    const needle = String(trigger || "").toLowerCase().trim();
    if (!needle || !text.includes(needle)) continue;
    score = Math.max(score, 30 + Math.min(10, needle.length / 4));
  }
  if (text.includes(skill.name.toLowerCase())) score = Math.max(score, 18);
  const title = skill.title.toLowerCase();
  if (title.length >= 3 && text.includes(title)) score = Math.max(score, 16);
  return score;
}

export class HarnessSkillRegistry {
  #skills = new Map();
  #builtins = new Map();
  #eventBus;

  constructor({ eventBus = null } = {}) {
    this.#eventBus = eventBus;
  }

  register(skill, { builtin = false } = {}) {
    const normalized = Object.freeze({ ...skill });
    if (!SKILL_NAME.test(normalized.name)) {
      throw new Error(`Invalid skill name: ${normalized.name || "<empty>"}`);
    }
    if (builtin) this.#builtins.set(normalized.name, normalized);
    mergeSkill(this.#skills, normalized);
    this.#eventBus?.emit({
      type: "skill.registered",
      skill: normalized.name,
      source: normalized.source,
    });
    return summary(this.#skills.get(normalized.name));
  }

  async catalog({ workspacePath = "", userSkillsDirectory = "", builtinDirectory = "" } = {}) {
    const catalog = new Map(this.#builtins);
    const roots = [
      [builtinDirectory, "builtin", builtinDirectory],
      [userSkillsDirectory, "user", userSkillsDirectory],
      [workspacePath ? join(workspacePath, ".aporiax", "skills") : "", "project", workspacePath],
    ];
    for (const [root, source, allowedRoot] of roots) {
      const loaded = await loadSkillRoot(root, source, allowedRoot);
      for (const skill of loaded) mergeSkill(catalog, skill);
    }
    return [...catalog.values()];
  }

  async discover(options = {}) {
    const catalog = await this.catalog(options);
    this.#skills = new Map(catalog.map((skill) => [skill.name, skill]));
    const result = this.list();
    this.#eventBus?.emit({
      type: "skills.discovered",
      count: result.length,
      workspacePath: options.workspacePath || null,
    });
    return result;
  }

  list() {
    return [...this.#skills.values()]
      .map(summary)
      .sort((left, right) =>
        (SOURCE_PRIORITY[right.source] || 0) - (SOURCE_PRIORITY[left.source] || 0) ||
        left.name.localeCompare(right.name),
      );
  }

  get(name, { includeInstructions = false } = {}) {
    const skill = this.#skills.get(String(name || "").trim().toLowerCase());
    if (!skill) return null;
    return includeInstructions ? { ...skill } : summary(skill);
  }

  match(prompt, { limit = 2, catalog = null } = {}) {
    const skills = Array.isArray(catalog) ? catalog : [...this.#skills.values()];
    const byName = new Map(skills.map((skill) => [skill.name, skill]));
    const explicit = explicitSkillNames(prompt);
    const matched = [];
    const unresolved = [];
    for (const name of explicit) {
      const skill = byName.get(name);
      if (skill) matched.push({ skill, reason: "explicit", score: 100 });
      else unresolved.push(name);
    }
    const explicitSet = new Set(matched.map((item) => item.skill.name));
    const automatic = skills
      .filter((skill) => !explicitSet.has(skill.name))
      .map((skill) => ({ skill, score: automaticScore(skill, prompt), reason: "auto" }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name));
    for (const item of automatic) {
      if (matched.length >= Math.max(1, limit)) break;
      matched.push(item);
    }
    return {
      skills: matched.slice(0, Math.max(1, limit)).map((item) => ({
        ...summary(item.skill),
        reason: item.reason,
        score: item.score,
      })),
      unresolved,
    };
  }

  activate(prompt, { limit = 2, catalog = null } = {}) {
    const skills = Array.isArray(catalog) ? catalog : [...this.#skills.values()];
    const byName = new Map(skills.map((skill) => [skill.name, skill]));
    const match = this.match(prompt, { limit, catalog: skills });
    const activated = match.skills
      .map((item) => {
        const skill = byName.get(item.name);
        return skill ? { ...skill, reason: item.reason, score: item.score } : null;
      })
      .filter(Boolean);
    for (const skill of activated) {
      this.#eventBus?.emit({
        type: "skill.activated",
        skill: skill.name,
        source: skill.source,
        reason: skill.reason,
      });
    }
    return { skills: activated, unresolved: match.unresolved };
  }
}

export function createSkillRegistry(options) {
  return new HarnessSkillRegistry(options);
}

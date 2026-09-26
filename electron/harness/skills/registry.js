import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";
import { fileURLToPath } from "node:url";
import { parseMentionTokens } from "../../../shared/mention-tokens.js";

export const SKILL_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const MAX_SKILL_FILE_BYTES = 128_000;
const SOURCE_PRIORITY = {
  builtin: 1,
  user: 2,
  project: 3,
};

function parseFrontmatter(source) {
  const text = String(source || "").replace(/^\uFEFF/, "");
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_FILE_BYTES) throw new Error("Skill document exceeds 128 KB.");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    if (/^---\r?\n/.test(text)) throw new Error("Unclosed Skill YAML frontmatter.");
    return { metadata: {}, body: text };
  }
  if (match[1].length > 32_000) throw new Error("Skill frontmatter exceeds 32 KB.");
  const doc = parseDocument(match[1], { version: "1.2", schema: "core", uniqueKeys: true, stringKeys: true, prettyErrors: false });
  if (doc.errors.length || doc.warnings.length) throw new Error("Invalid Skill YAML: " + (doc.errors[0] || doc.warnings[0]).message);
  const metadata = doc.toJS({ maxAliasCount: 20 }) || {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Skill frontmatter must be an object.");
  const seen = new Set();
  let nodes = 0;
  function check(value, depth = 0) {
    if (++nodes > 2048 || depth > 16) throw new Error("Skill metadata nesting/size limit exceeded.");
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) throw new Error("Skill metadata aliases/cycles are not supported.");
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Unsafe Skill metadata key.");
      check(child, depth + 1);
    }
  }
  check(metadata);
  return { metadata, body: text.slice(match[0].length).trim() };
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
  for (const key of ["name", "title", "description", "license", "compatibility"]) {
    if (metadata[key] !== undefined && typeof metadata[key] !== "string") throw new Error(`Skill ${key} must be text.`);
  }
  if (metadata.metadata !== undefined && (!metadata.metadata || typeof metadata.metadata !== "object" || Array.isArray(metadata.metadata))) throw new Error("Skill metadata must be an object.");
  const fallbackName = String(options.fallbackName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = String(metadata.name || fallbackName).trim().toLowerCase();
  if (!SKILL_NAME.test(name)) {
    throw new Error(`Invalid skill name: ${name || "<empty>"}`);
  }
  const instructions = String(body || "");
  if (instructions.length > MAX_SKILL_FILE_BYTES) throw new Error(`Skill ${name} is too large; split it into referenced files.`);
  if (!instructions.trim()) {
    throw new Error(`Skill ${name} has no instructions.`);
  }
  return Object.freeze({
    name,
    title: String(metadata.title || name).trim().slice(0, 120),
    description: String(metadata.description || "").trim().slice(0, 1024),
    version: String(metadata.version || metadata.metadata?.version || "1").trim().slice(0, 80),
    license: String(metadata.license || "").slice(0, 200),
    compatibility: String(metadata.compatibility || "").slice(0, 500),
    allowedTools: metadata["allowed-tools"] ?? null,
    compatibilityWarnings: [
      ...(metadata["allowed-tools"] ? ["allowed-tools is guidance only; AporiaX task permissions remain authoritative."] : []),
      ...(["hooks", "context", "agent", "model"].filter((key) => metadata[key] !== undefined).map((key) => `${key}: stored as metadata, not executed by this host.`)),
    ],
    metadata: Object.freeze(metadata.metadata || {}),
    frontmatter: Object.freeze(metadata),
    packageRoot: options.path && !String(options.path).includes("://") ? dirname(resolve(options.path)) : "",
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
    throw new Error("Skill must be a regular, non-linked file under 128 KB.");
  }
  const text = await readFile(skillPath, "utf8");
  const parsed = parseSkillDocument(text, {
    source,
    path: skillPath,
    fallbackName,
  });
  // Optional isolated runtimes live outside the versioned Skill package.
  // Discovery only checks a file; it never runs Python or installs dependencies.
  if (source === "user" && parsed.metadata.runtime === "python") {
    const executable = join(dirname(dirname(dirname(skillPath))), "skill-runtimes", parsed.name,
      ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
    const available = await lstat(executable).then((stats) => stats.isFile() || stats.isSymbolicLink()).catch(() => false);
    if (available) return Object.freeze({ ...parsed, runtime: { kind: "python", executable, status: "installed-not-tested" } });
  }
  return parsed;
}

async function loadSkillRoot(rootDirectory, source, allowedRoot = "", diagnostics = []) {
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
  }).catch((error) => { diagnostics.push({ path: join(root, "SKILL.md"), error: error.message }); return null; });
  if (rootSkill) skills.push(rootSkill);

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return skills;
  }
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."));
  if (directories.length > 256) diagnostics.push({ path: root, error: "Only the first 256 Skill directories were loaded." });
  for (const entry of directories.slice(0, 256)) {
    const skill = await loadSkillFile(join(root, entry.name, "SKILL.md"), {
      source,
      fallbackName: entry.name,
    }).catch((error) => { diagnostics.push({ path: join(root, entry.name, "SKILL.md"), error: error.message }); return null; });
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
    license: skill.license || "",
    compatibility: skill.compatibility || "",
    compatibilityWarnings: skill.compatibilityWarnings || [],
    runtime: skill.runtime || null,
    metadata: skill.metadata || {},
    packageRoot: skill.packageRoot || "",
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
  const names = parseMentionTokens(text).filter((token) => token.kind === "skill").map((token) => token.value);
  const patterns = [
    /(?:^|[\s（(【\[])\/skill(?::|\s+)([a-z0-9][a-z0-9_-]{0,63})(?=$|[\s,，。.!?！？;；)）\]】])/gi,
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

  async catalog({ workspacePath = "", userSkillsDirectory = "", builtinDirectory = fileURLToPath(new URL("../../library/curated/", import.meta.url)) } = {}) {
    const catalog = new Map(this.#builtins);
    const diagnostics = [];
    const roots = [
      [builtinDirectory, "builtin", builtinDirectory],
      [userSkillsDirectory, "user", userSkillsDirectory],
      [workspacePath ? join(workspacePath, ".aporiax", "skills") : "", "project", workspacePath],
    ];
    for (const [root, source, allowedRoot] of roots) {
      const loaded = await loadSkillRoot(root, source, allowedRoot, diagnostics);
      for (const skill of loaded) mergeSkill(catalog, skill);
    }
    const result = [...catalog.values()];
    Object.defineProperty(result, "diagnostics", { value: diagnostics });
    return result;
  }

  async discover(options = {}) {
    const catalog = await this.catalog(options);
    this.#skills = new Map(catalog.map((skill) => [skill.name, skill]));
    const result = this.list();
    Object.defineProperty(result, "diagnostics", { value: catalog.diagnostics || [] });
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
      // The limit bounds automatic matching, never the user's explicit selection.
      skills: matched.map((item) => ({
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

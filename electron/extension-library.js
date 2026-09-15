import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillDocument, SKILL_NAME } from "./harness/skills/registry.js";
import { withExtensionWriteLock } from "./extension-store-lock.js";
import {
  loadMcpConfiguration,
  normalizeMcpServer,
  publicMcpServerSummary,
} from "./mcp-config.js";

const LIBRARY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "library");
const CATALOG_PATH = join(LIBRARY_ROOT, "catalog.json");
const MAX_CATALOG_BYTES = 512_000;
const MAX_MCP_CONFIG_BYTES = 512_000;
const MAX_IMPORTED_SKILL_BYTES = 20_000_000;
const MAX_IMPORTED_SKILL_FILES = 500;

function isInside(root, candidate) {
  const child = relative(resolve(root), resolve(candidate));
  return (
    child === "" ||
    (!child.startsWith("..") && !isAbsolute(child))
  );
}

async function readJson(path, maximumBytes) {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maximumBytes) {
      throw new Error(`Unsafe or oversized JSON file: ${path}`);
    }
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flush: true });
  try {
    // Same-directory rename replaces the old file without a missing-config window.
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function publicCatalogEntry(entry) {
  return {
    id: String(entry.id || ""),
    type: String(entry.type || ""),
    name: String(entry.name || ""),
    title: String(entry.title || entry.name || ""),
    titleEn: String(entry.titleEn || entry.title || entry.name || ""),
    titleZh: String(entry.titleZh || entry.title || entry.name || ""),
    description: String(entry.description || ""),
    descriptionEn: String(entry.descriptionEn || entry.description || ""),
    descriptionZh: String(entry.descriptionZh || entry.description || ""),
    version: String(entry.version || "1"),
    author: String(entry.author || "AporiaX"),
    tags: Array.isArray(entry.tags) ? entry.tags.map(String).slice(0, 12) : [],
    trust: String(entry.trust || "bundled"),
    license: String(entry.license || ""),
    sourceUrl: String(entry.sourceUrl || ""),
    requirements: Array.isArray(entry.requirements) ? entry.requirements.map(String) : [],
    ...(entry.type === "mcp-template"
      ? {
          template: {
            id: String(entry.template?.id || ""),
            name: String(entry.template?.name || ""),
            transport: entry.template?.transport || "streamable-http",
            command: entry.template?.command || "",
            url: entry.template?.url || "",
            headers: entry.template?.headers || {},
            env: entry.template?.env || {},
            args: Array.isArray(entry.template?.args)
              ? entry.template.args.map(String).slice(0, 24)
              : [],
          },
        }
      : {}),
  };
}

export async function loadExtensionCatalog() {
  const raw = await readJson(CATALOG_PATH, MAX_CATALOG_BYTES);
  const entries = [];
  for (const entry of Array.isArray(raw?.entries) ? raw.entries.slice(0, 128) : []) {
    const id = String(entry?.id || "").trim();
    const type = String(entry?.type || "").trim();
    if (!id || !new Set(["skill", "mcp-template"]).has(type)) continue;
    if (type === "skill") {
      const name = String(entry.name || "").trim().toLowerCase();
      const skillFile = resolve(LIBRARY_ROOT, String(entry.skillFile || ""));
      if (!SKILL_NAME.test(name) || !isInside(LIBRARY_ROOT, skillFile)) continue;
      entries.push({ ...entry, id, type, name, skillFile });
      continue;
    }
    entries.push({ ...entry, id, type });
  }
  return {
    version: Number(raw?.version) || 1,
    source: String(raw?.source || "bundled"),
    entries,
  };
}

export async function extensionLibrarySnapshot({
  userDataDirectory,
  workspacePath = "",
} = {}) {
  const catalog = await loadExtensionCatalog();
  const mcp = await loadMcpConfiguration({ userDataDirectory, workspacePath });
  return {
    catalog: {
      version: catalog.version,
      source: catalog.source,
      entries: catalog.entries.map(publicCatalogEntry),
    },
    installed: {
      skillsDirectory: join(userDataDirectory, "skills"),
      skillNames: await installedUserSkillNames(userDataDirectory),
      skillPackages: await installedSkillPackages(userDataDirectory),
      mcpServers: mcp.allServers.map(publicMcpServerSummary),
    },
    mcpConfigPath: mcp.userConfigPath,
  };
}

async function installedUserSkillNames(userDataDirectory) {
  const names = [];
  const skillsRoot = join(userDataDirectory, "skills");
  let entries = [];
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return names;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SKILL_NAME.test(entry.name)) continue;
    const target = join(skillsRoot, entry.name, "SKILL.md");
    try {
      const stats = await lstat(target);
      if (stats.isFile() && !stats.isSymbolicLink()) names.push(entry.name);
    } catch {
      // Ignore incomplete user packages.
    }
  }
  return names.sort((left, right) => left.localeCompare(right));
}

export async function inspectSkillDirectory(root) {
  let files = 0;
  let bytes = 0;
  let entriesSeen = 0;
  const hashes = {};
  async function visit(directory, depth = 0) {
    if (depth > 16) throw new Error("Skill package directory depth exceeds 16.");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entriesSeen > 1000) throw new Error("Skill package exceeds 1000 directory entries.");
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) throw new Error("Skill packages may not contain symbolic links.");
      if (stats.isDirectory()) await visit(path, depth + 1);
      else if (stats.isFile()) {
        files += 1;
        bytes += stats.size;
        if (files > MAX_IMPORTED_SKILL_FILES || bytes > MAX_IMPORTED_SKILL_BYTES) {
          throw new Error("Skill package exceeds the 500 file / 20 MB import limit.");
        }
        hashes[relative(root, path).replaceAll("\\", "/")] = createHash("sha256").update(await readFile(path)).digest("hex");
      } else throw new Error("Skill packages may only contain regular files and directories.");
    }
  }
  await visit(root);
  return { files, bytes, hashes };
}

async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function installedSkillPackages(userDataDirectory) {
  return Promise.all((await installedUserSkillNames(userDataDirectory)).map(async (name) => ({
    name,
    canRollback: (await readdir(join(userDataDirectory, "skills", ".history", name)).catch(() => [])).length > 0,
  })));
}

export async function importUserSkill({ userDataDirectory, sourceDirectory, onlineSource = null } = {}) {
  return withExtensionWriteLock(userDataDirectory, () => installSkillPackage({ userDataDirectory, sourceDirectory, onlineSource }));
}

async function installSkillPackage({ userDataDirectory, sourceDirectory, rollback = false, onlineSource = null }) {
  const lexical = resolve(String(sourceDirectory || ""));
  const lexicalStats = await lstat(lexical);
  if (!lexicalStats.isDirectory() || lexicalStats.isSymbolicLink()) throw new Error("Select a real Skill directory, not a symbolic link.");
  const source = await realpath(lexical);
  const skillFile = join(source, "SKILL.md");
  const skillStats = await lstat(skillFile);
  if (!skillStats.isFile() || skillStats.isSymbolicLink() || skillStats.size > MAX_CATALOG_BYTES) throw new Error("Missing or unsafe SKILL.md.");
  const text = await readFile(skillFile, "utf8");
  const parsed = parseSkillDocument(text, { source: "user", fallbackName: source.split(/[\\/]/).at(-1), path: skillFile });
  const packageStats = await inspectSkillDirectory(source);
  const root = join(userDataDirectory, "skills");
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Skill store cannot be a symbolic link.");
  const target = join(root, parsed.name);
  if (!isInside(root, target) || target === root) throw new Error("Unsafe Skill import path.");
  if (!rollback && await exists(target)) {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("Installed Skill cannot be a symbolic link.");
    const provenance = await readJson(join(target, ".aporiax-package.json"), MAX_CATALOG_BYTES);
    const sameSource = onlineSource
      ? provenance?.onlineSource?.identity === onlineSource.identity
      : !provenance?.onlineSource && (!provenance?.source || relative(provenance.source, source) === "");
    if (!sameSource) {
      throw new Error("A Skill with this name exists from a different source. Rename the new Skill or explicitly uninstall the existing one first.");
    }
  }
  const temporary = join(root, ".import-" + parsed.name + "-" + randomUUID());
  const history = join(root, ".history", parsed.name);
  const previous = join(history, Date.now() + "-" + randomUUID());
  let moved = false;
  let installed = false;
  try {
    await cp(source, temporary, { recursive: true, errorOnExist: true });
    // Re-inspect the copy. Do not execute setup/check scripts while importing.
    const copied = await inspectSkillDirectory(temporary);
    if (JSON.stringify(copied.hashes) !== JSON.stringify(packageStats.hashes)) throw new Error("Skill package changed during import; retry with a stable source.");
    if (await readFile(join(temporary, "SKILL.md"), "utf8") !== text) throw new Error("SKILL.md changed during import; retry with a stable source package.");
    const previousProvenance = rollback ? await readJson(join(temporary, ".aporiax-package.json"), MAX_CATALOG_BYTES) : null;
    const upstream = await readJson(join(temporary, ".aporiax-source.json"), MAX_CATALOG_BYTES);
    await writeFile(join(temporary, ".aporiax-package.json"), JSON.stringify({
      name: parsed.name, version: parsed.version, license: parsed.license,
      source: previousProvenance?.source || source, upstream, files: copied.hashes, importedAt: new Date().toISOString(),
      onlineSource: previousProvenance?.onlineSource || onlineSource,
      instructionSha256: createHash("sha256").update(text).digest("hex"),
    }, null, 2), "utf8");
    if (await exists(target)) {
      if ((await lstat(target)).isSymbolicLink()) throw new Error("Installed Skill cannot be a symbolic link.");
      await mkdir(history, { recursive: true });
      if (relative(await realpath(history), resolve(history)) !== "") throw new Error("Unsafe Skill history directory.");
      await rename(target, previous);
      moved = true;
    }
    await rename(temporary, target);
    installed = true;
    return { imported: true, skill: { name: parsed.name, title: parsed.title, description: parsed.description, source: "user", license: parsed.license, version: parsed.version },
      path: target, previousVersionPath: moved ? previous : null, files: packageStats.files, bytes: packageStats.bytes };
  } catch (error) {
    if (moved && !installed) {
      try { await rename(previous, target); }
      catch (restoreError) { throw new Error("Skill update failed; previous package preserved at " + previous + ". Restore error: " + restoreError.message); }
    }
    throw error;
  } finally {
    if (!installed) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function rollbackUserSkill({ userDataDirectory, name } = {}) {
  if (!SKILL_NAME.test(String(name || ""))) throw new Error("Invalid Skill name.");
  return withExtensionWriteLock(userDataDirectory, async () => {
    const root = join(userDataDirectory, "skills", ".history", name);
    const entries = (await readdir(root, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return []; throw error;
    })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name).sort().reverse();
    if (!entries.length) throw new Error("No previous Skill package is available.");
    if (relative(await realpath(root), resolve(root)) !== "") throw new Error("Unsafe Skill history directory.");
    const result = await installSkillPackage({ userDataDirectory, sourceDirectory: join(root, entries[0]), rollback: true });
    return { ...result, rolledBack: true };
  });
}

export async function installCatalogSkill({ userDataDirectory, catalogId } = {}) {
  const catalog = await loadExtensionCatalog();
  const entry = catalog.entries.find((item) => item.id === String(catalogId || "") && item.type === "skill");
  if (!entry) throw new Error("Unknown Skill catalog entry.");
  const parsed = parseSkillDocument(await readFile(entry.skillFile, "utf8"), { fallbackName: entry.name });
  if (parsed.name !== entry.name) throw new Error("Skill package name does not match its catalog manifest.");
  const result = await importUserSkill({ userDataDirectory, sourceDirectory: dirname(entry.skillFile) });
  return { ...result, installed: true, skill: publicCatalogEntry(entry), path: join(result.path, "SKILL.md") };
}

export async function removeUserSkill({ userDataDirectory, name } = {}) {
  return withExtensionWriteLock(userDataDirectory, () => removeUserSkillUnlocked({ userDataDirectory, name }));
}

async function removeUserSkillUnlocked({ userDataDirectory, name }) {
  const skillName = String(name || "").trim().toLowerCase();
  if (!SKILL_NAME.test(skillName)) throw new Error("Invalid Skill name.");
  const skillsRoot = join(userDataDirectory, "skills");
  const target = join(skillsRoot, skillName);
  if (!isInside(skillsRoot, target) || resolve(target) === resolve(skillsRoot)) {
    throw new Error("Unsafe Skill removal path.");
  }
  if (await exists(skillsRoot) && relative(await realpath(skillsRoot), resolve(skillsRoot)) !== "") throw new Error("Unsafe Skill store directory.");
  await rm(target, { recursive: true, force: true });
  return { removed: true, name: skillName };
}

async function readRawMcpConfig(userDataDirectory) {
  const path = join(userDataDirectory, "aporiax-mcp.json");
  const raw = (await readJson(path, MAX_MCP_CONFIG_BYTES)) || {};
  return {
    path,
    value: {
      ...raw,
      servers: Array.isArray(raw.servers) ? raw.servers : [],
    },
  };
}

export async function saveMcpServer({ userDataDirectory, server, createOnly = false } = {}) {
  return withExtensionWriteLock(userDataDirectory, () => saveMcpServerUnlocked({ userDataDirectory, server, importing: createOnly }));
}

async function saveMcpServerUnlocked({ userDataDirectory, server, importing = false }) {
  const normalized = normalizeMcpServer(server || {});
  const { path, value } = await readRawMcpConfig(userDataDirectory);
  const rawServer = {
    id: normalized.id,
    name: String(server?.name || normalized.name),
    transport: normalized.transport,
    enabled: server?.enabled !== false,
    autoApproveReadOnly: server?.autoApproveReadOnly === true,
    timeoutMs: normalized.timeoutMs,
    ...(normalized.transport === "stdio"
      ? {
          command: String(server.command || "").trim(),
          args: Array.isArray(server.args) ? server.args.map(String) : [],
          cwd: String(server.cwd || "").trim(),
          env: server.env && typeof server.env === "object" ? server.env : {},
        }
      : {
          url: String(server.url || "").trim(),
          headers:
            server.headers && typeof server.headers === "object"
              ? server.headers
              : {},
        }),
  };
  const index = value.servers.findIndex(
    (item) => String(item?.id || "").trim().toLowerCase() === normalized.id,
  );
  if (index >= 0 && importing) throw new Error(`MCP server id already exists: ${normalized.id}; existing configuration was preserved.`);
  if (index >= 0) value.servers[index] = rawServer;
  else {
    if (value.servers.length >= 64) throw new Error("MCP config already contains 64 entries; remove an entry first.");
    value.servers.push(rawServer);
  }
  await writeJsonAtomic(path, value);
  return { saved: true, server: publicMcpServerSummary(normalized), path };
}

function importedMcpServers(raw) {
  if (Array.isArray(raw?.servers)) return raw.servers.map((server) => ({ ...server, enabled: false }));
  if (raw?.mcpServers && typeof raw.mcpServers === "object" && !Array.isArray(raw.mcpServers)) {
    return Object.entries(raw.mcpServers).map(([name, server]) => ({
      ...(server || {}),
      id: String(server?.id || name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^[^a-z]+/, "mcp-"),
      name: String(server?.name || name),
      transport: server?.transport || (server?.type === "sse" ? "sse" : (["http", "streamable-http"].includes(server?.type) || server?.url ? "streamable-http" : "stdio")),
      enabled: false,
    }));
  }
  if (raw?.command || raw?.url) return [{ ...raw, transport: raw.transport || (raw.type === "sse" ? "sse" : raw.url ? "streamable-http" : "stdio"), enabled: false }];
  return [];
}

export async function importMcpConfiguration({ userDataDirectory, sourcePath } = {}) {
  const source = await realpath(String(sourcePath || ""));
  const raw = await readJson(source, MAX_MCP_CONFIG_BYTES);
  const servers = importedMcpServers(raw);
  if (servers.length > 64) throw new Error("Import exceeds 64 MCP entries; split the configuration explicitly.");
  if (!servers.length) {
    throw new Error("No MCP servers were found in this JSON file.");
  }
  const imported = [];
  const errors = [];
  for (const server of servers) {
    try {
      const result = await withExtensionWriteLock(userDataDirectory, () => saveMcpServerUnlocked({ userDataDirectory, server, importing: true }));
      imported.push(result.server);
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }
  if (!imported.length) {
    throw new Error(errors.join("; ") || "MCP import failed.");
  }
  return { imported, errors, source };
}

export async function removeMcpServer({ userDataDirectory, id } = {}) {
  return withExtensionWriteLock(userDataDirectory, () => removeMcpServerUnlocked({ userDataDirectory, id }));
}

export async function setMcpServerEnabled({ userDataDirectory, id, enabled } = {}) {
  if (typeof enabled !== "boolean") throw new Error("MCP enabled must be a boolean.");
  return withExtensionWriteLock(userDataDirectory, async () => {
    const { path, value } = await readRawMcpConfig(userDataDirectory);
    const server = value.servers.find((item) => item?.id === id);
    if (!server) throw new Error("Unknown MCP server.");
    server.enabled = enabled;
    await writeJsonAtomic(path, value);
    return { id, enabled };
  });
}

export async function probeMcpServer({ userDataDirectory, id } = {}) {
  const configuration = await loadMcpConfiguration({ userDataDirectory });
  const server = configuration.allServers.find((item) => item.id === id);
  if (!server) throw new Error("Unknown or invalid MCP server.");
  if (server.missingEnvironment?.length) throw new Error("MCP_ENV_MISSING: " + server.missingEnvironment.join(", "));
  const { createMcpRuntime } = await import("./mcp-runtime.js");
  const runtime = createMcpRuntime({ servers: [{ ...server, enabled: true }] });
  try {
    const discovered = await runtime.discover({ permissionMode: "read-only" });
    if (discovered.errors.length) throw new Error(discovered.errors.map((item) => item.error).join("; "));
    return { id, discoveryStatus: "passed", toolCount: discovered.servers[0]?.toolCount || 0,
      checkedAt: new Date().toISOString(), connected: false,
      note: "Tool discovery passed; probe connection is closed. No remote action tool was called." };
  } finally { await runtime.close(); }
}

async function removeMcpServerUnlocked({ userDataDirectory, id }) {
  const serverId = String(id || "").trim().toLowerCase();
  if (!serverId) throw new Error("MCP server id is required.");
  const { path, value } = await readRawMcpConfig(userDataDirectory);
  value.servers = value.servers.filter(
    (item) => String(item?.id || "").trim().toLowerCase() !== serverId,
  );
  await writeJsonAtomic(path, value);
  return { removed: true, id: serverId, path };
}

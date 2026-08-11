import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillDocument } from "./harness/skills/registry.js";
import {
  loadMcpConfiguration,
  normalizeMcpServer,
  publicMcpServerSummary,
} from "./mcp-config.js";

const LIBRARY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "library");
const CATALOG_PATH = join(LIBRARY_ROOT, "catalog.json");
const SKILL_NAME = /^[a-z][a-z0-9_-]{1,63}$/;
const MAX_CATALOG_BYTES = 512_000;
const MAX_MCP_CONFIG_BYTES = 512_000;

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
  const backup = `${path}.backup`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rm(backup, { force: true }).catch(() => undefined);
  let movedOriginal = false;
  try {
    await rename(path, backup);
    movedOriginal = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  try {
    await rename(temporary, path);
    if (movedOriginal) await rm(backup, { force: true });
  } catch (error) {
    if (movedOriginal) await rename(backup, path).catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
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
    ...(entry.type === "mcp-template"
      ? {
          template: {
            transport: entry.template?.transport || "streamable-http",
            command: entry.template?.command || "",
            url: entry.template?.url || "",
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
      mcpServers: mcp.allServers.map(publicMcpServerSummary),
    },
    mcpConfigPath: mcp.userConfigPath,
  };
}

async function installedUserSkillNames(userDataDirectory) {
  const catalog = await loadExtensionCatalog();
  const names = [];
  for (const entry of catalog.entries.filter((item) => item.type === "skill")) {
    const target = join(userDataDirectory, "skills", entry.name, "SKILL.md");
    try {
      const stats = await lstat(target);
      if (stats.isFile() && !stats.isSymbolicLink()) names.push(entry.name);
    } catch {
      // Not installed from the bundled catalog.
    }
  }
  return names;
}

export async function installCatalogSkill({ userDataDirectory, catalogId } = {}) {
  const catalog = await loadExtensionCatalog();
  const entry = catalog.entries.find(
    (item) => item.id === String(catalogId || "") && item.type === "skill",
  );
  if (!entry) throw new Error("Unknown Skill catalog entry.");
  const source = await readFile(entry.skillFile, "utf8");
  const parsed = parseSkillDocument(source, {
    source: "user",
    fallbackName: entry.name,
    path: entry.skillFile,
  });
  if (parsed.name !== entry.name) {
    throw new Error("Skill package name does not match its catalog manifest.");
  }
  const skillsRoot = join(userDataDirectory, "skills");
  const targetDirectory = join(skillsRoot, parsed.name);
  const target = join(targetDirectory, "SKILL.md");
  if (!isInside(skillsRoot, target)) throw new Error("Unsafe Skill install path.");
  await mkdir(targetDirectory, { recursive: true });
  const temporary = join(targetDirectory, `SKILL.${randomUUID()}.tmp`);
  await writeFile(temporary, source, "utf8");
  await rm(target, { force: true });
  await rename(temporary, target);
  return { installed: true, skill: publicCatalogEntry(entry), path: target };
}

export async function removeUserSkill({ userDataDirectory, name } = {}) {
  const skillName = String(name || "").trim().toLowerCase();
  if (!SKILL_NAME.test(skillName)) throw new Error("Invalid Skill name.");
  const skillsRoot = join(userDataDirectory, "skills");
  const target = join(skillsRoot, skillName);
  if (!isInside(skillsRoot, target) || resolve(target) === resolve(skillsRoot)) {
    throw new Error("Unsafe Skill removal path.");
  }
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
      servers: Array.isArray(raw.servers) ? raw.servers.slice(0, 64) : [],
    },
  };
}

export async function saveMcpServer({ userDataDirectory, server } = {}) {
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
  if (index >= 0) value.servers[index] = rawServer;
  else value.servers.push(rawServer);
  await writeJsonAtomic(path, value);
  return { saved: true, server: publicMcpServerSummary(normalized), path };
}

export async function removeMcpServer({ userDataDirectory, id } = {}) {
  const serverId = String(id || "").trim().toLowerCase();
  if (!serverId) throw new Error("MCP server id is required.");
  const { path, value } = await readRawMcpConfig(userDataDirectory);
  value.servers = value.servers.filter(
    (item) => String(item?.id || "").trim().toLowerCase() !== serverId,
  );
  await writeJsonAtomic(path, value);
  return { removed: true, id: serverId, path };
}

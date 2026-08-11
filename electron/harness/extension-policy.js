import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const CONFIG_VERSION = 1;
const MAX_CONFIG_BYTES = 64_000;
export const MANAGED_EXTENSION_SOURCES = Object.freeze([
  "browser",
  "plugin",
  "skill",
  "mcp",
]);

function inside(root, target) {
  const child = relative(root, target);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function defaultSources() {
  return Object.fromEntries(MANAGED_EXTENSION_SOURCES.map((source) => [source, true]));
}

function normalizeSource(source) {
  const value = String(source || "").trim().toLowerCase();
  if (!MANAGED_EXTENSION_SOURCES.includes(value)) {
    throw new Error(`Unsupported extension source: ${value || "<empty>"}`);
  }
  return value;
}

function normalizeUserConfig(value) {
  const sources = defaultSources();
  if (value?.sources && typeof value.sources === "object" && !Array.isArray(value.sources)) {
    for (const source of MANAGED_EXTENSION_SOURCES) {
      if (typeof value.sources[source] === "boolean") sources[source] = value.sources[source];
    }
  }
  return { version: CONFIG_VERSION, sources };
}

function normalizeProjectConfig(value) {
  const disabled = [...new Set(
    (Array.isArray(value?.disabled) ? value.disabled : [])
      .map((source) => String(source || "").trim().toLowerCase())
      .filter((source) => MANAGED_EXTENSION_SOURCES.includes(source)),
  )];
  return { version: CONFIG_VERSION, disabled };
}

async function readBoundedJson(path, { root = "" } = {}) {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_CONFIG_BYTES) return null;
    const target = await realpath(path);
    if (root) {
      const verifiedRoot = await realpath(root);
      if (!inside(verifiedRoot, target)) return null;
    }
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`Invalid extension policy JSON: ${path}`);
    throw error;
  }
}

export async function loadExtensionPolicy({ userDataDirectory, workspacePath = "" } = {}) {
  if (!userDataDirectory) throw new Error("Extension policy requires the Electron user-data directory.");
  const userConfigPath = join(userDataDirectory, "aporiax-extensions.json");
  const userConfig = normalizeUserConfig(await readBoundedJson(userConfigPath));

  let projectConfigPath = null;
  let project = normalizeProjectConfig(null);
  if (workspacePath) {
    const workspaceRoot = await realpath(resolve(workspacePath)).catch(() => null);
    if (workspaceRoot) {
      projectConfigPath = join(workspaceRoot, ".aporiax", "extensions.json");
      project = normalizeProjectConfig(
        await readBoundedJson(projectConfigPath, { root: workspaceRoot }),
      );
    }
  }

  const effective = { ...userConfig.sources };
  for (const source of project.disabled) effective[source] = false;
  return {
    version: CONFIG_VERSION,
    sources: userConfig.sources,
    projectDisabled: project.disabled,
    effective,
    userConfigPath,
    projectConfigPath,
  };
}

export async function setExtensionSourceEnabled({
  userDataDirectory,
  source,
  enabled,
} = {}) {
  if (!userDataDirectory) throw new Error("Extension policy requires the Electron user-data directory.");
  const normalizedSource = normalizeSource(source);
  const current = await loadExtensionPolicy({ userDataDirectory });
  const next = {
    version: CONFIG_VERSION,
    sources: {
      ...current.sources,
      [normalizedSource]: Boolean(enabled),
    },
  };
  const path = current.userConfigPath;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
  return loadExtensionPolicy({ userDataDirectory });
}

export function extensionSourceEnabled(policy, source) {
  const normalizedSource = normalizeSource(source);
  return policy?.effective?.[normalizedSource] !== false;
}

export function capabilityAvailability(capability, policy) {
  const source = String(capability?.source || "runtime").toLowerCase();
  if (!MANAGED_EXTENSION_SOURCES.includes(source)) {
    return { enabled: true, reason: "core-capability" };
  }
  if (policy?.sources?.[source] === false) {
    return { enabled: false, reason: "disabled-by-user" };
  }
  if (policy?.projectDisabled?.includes(source)) {
    return { enabled: false, reason: "disabled-by-project" };
  }
  return { enabled: true, reason: "enabled" };
}

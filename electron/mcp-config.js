import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const MAX_CONFIG_BYTES = 512_000;
const SERVER_ID = /^[a-z][a-z0-9_-]{1,47}$/;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function inside(root, target) {
  const child = relative(root, target);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function readJsonFile(path, { root = "" } = {}) {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_CONFIG_BYTES) {
      return null;
    }
    const target = await realpath(path);
    if (root) {
      const verifiedRoot = await realpath(root);
      if (!inside(verifiedRoot, target)) return null;
    }
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid MCP JSON config: ${path}`);
    }
    throw error;
  }
}

function stringArray(value, limit = 64) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).map((item) => item.trim()).filter(Boolean))]
    .slice(0, limit);
}

function stringRecord(value, limit = 64) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, limit)
      .map(([key, item]) => [String(key).slice(0, 160), String(item ?? "").slice(0, 8_000)]),
  );
}

function interpolateEnvironment(value, environment = process.env) {
  return String(value ?? "").replace(ENV_REFERENCE, (_match, key) =>
    environment[key] === undefined ? "" : String(environment[key]),
  );
}

function interpolateRecord(record, environment) {
  return Object.fromEntries(
    Object.entries(record || {}).map(([key, value]) => [
      key,
      interpolateEnvironment(value, environment),
    ]),
  );
}

export function normalizeMcpServer(record = {}, { environment = process.env } = {}) {
  const id = String(record.id || "").trim().toLowerCase();
  if (!SERVER_ID.test(id)) throw new Error(`Invalid MCP server id: ${id || "<empty>"}`);
  const transport = String(record.transport || "stdio").trim().toLowerCase();
  if (!new Set(["stdio", "streamable-http"]).has(transport)) {
    throw new Error(`Unsupported MCP transport for ${id}: ${transport}`);
  }
  const enabled = record.enabled !== false;
  const autoApproveReadOnly = record.autoApproveReadOnly === true;
  const timeoutMs = Math.max(3_000, Math.min(120_000, Number(record.timeoutMs) || 30_000));

  if (transport === "stdio") {
    const command = String(record.command || "").trim();
    if (!command || command.length > 1_000) {
      throw new Error(`MCP stdio server ${id} requires a command.`);
    }
    return Object.freeze({
      id,
      name: String(record.name || id).trim().slice(0, 120),
      transport,
      enabled,
      command,
      args: stringArray(record.args, 64).map((item) => interpolateEnvironment(item, environment)),
      cwd: String(record.cwd || "").trim().slice(0, 2_000),
      env: interpolateRecord(stringRecord(record.env, 96), environment),
      autoApproveReadOnly,
      timeoutMs,
    });
  }

  let url;
  try {
    url = new URL(interpolateEnvironment(record.url, environment));
  } catch {
    throw new Error(`MCP HTTP server ${id} requires a valid URL.`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error(`MCP HTTP server ${id} only supports http/https.`);
  }
  if (url.username || url.password) {
    throw new Error(`MCP HTTP server ${id} must not embed credentials in its URL.`);
  }
  return Object.freeze({
    id,
    name: String(record.name || id).trim().slice(0, 120),
    transport,
    enabled,
    url: url.toString(),
    headers: interpolateRecord(stringRecord(record.headers, 96), environment),
    autoApproveReadOnly,
    timeoutMs,
  });
}

export function publicMcpServerSummary(server) {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    autoApproveReadOnly: server.autoApproveReadOnly,
    timeoutMs: server.timeoutMs,
    ...(server.transport === "stdio"
      ? {
          command: server.command,
          args: [...server.args],
          cwd: server.cwd || "",
          envKeys: Object.keys(server.env || {}),
        }
      : {
          url: server.url,
          headerKeys: Object.keys(server.headers || {}),
        }),
  };
}

export async function loadMcpConfiguration({
  userDataDirectory,
  workspacePath = "",
  environment = process.env,
} = {}) {
  if (!userDataDirectory) throw new Error("MCP user data directory is required.");
  const userConfigPath = join(userDataDirectory, "aporiax-mcp.json");
  const userConfig = (await readJsonFile(userConfigPath)) || {};
  const rawServers = Array.isArray(userConfig.servers) ? userConfig.servers : [];
  const normalized = [];
  const errors = [];
  for (const raw of rawServers.slice(0, 64)) {
    try {
      normalized.push(normalizeMcpServer(raw, { environment }));
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }

  let projectConfigPath = null;
  let projectSelection = null;
  if (workspacePath) {
    const projectRoot = await realpath(resolve(workspacePath)).catch(() => null);
    if (projectRoot) {
      projectConfigPath = join(projectRoot, ".aporiax", "mcp.json");
      const projectConfig = await readJsonFile(projectConfigPath, { root: projectRoot });
      if (projectConfig) {
        projectSelection = {
          servers: stringArray(projectConfig.servers, 64).map((item) => item.toLowerCase()),
          disabled: stringArray(projectConfig.disabled, 64).map((item) => item.toLowerCase()),
        };
      }
    }
  }

  const enabled = normalized.filter((server) => {
    if (!server.enabled) return false;
    if (projectSelection?.disabled.includes(server.id)) return false;
    if (projectSelection?.servers.length) {
      return projectSelection.servers.includes(server.id);
    }
    return true;
  });

  return {
    servers: enabled,
    allServers: normalized,
    errors,
    userConfigPath,
    projectConfigPath,
    projectSelection,
  };
}

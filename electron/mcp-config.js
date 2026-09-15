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
      throw new Error(`MCP config must be a regular, non-linked file under ${MAX_CONFIG_BYTES} bytes: ${path}`);
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
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("MCP env/headers must be a JSON object.");
  if (Object.keys(value).length > limit) throw new Error("Too many MCP environment/header entries.");
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => {
        if (!key || key.length > 160 || (item !== null && typeof item === "object") || String(item ?? "").length > 8000 || String(item ?? "").includes("\0")) throw new Error("Invalid MCP environment/header entry.");
        return [key, String(item ?? "")];
      }),
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
  const references = [...JSON.stringify([record.args, record.env, record.url, record.headers]).matchAll(ENV_REFERENCE)].map((match) => match[1]);
  const placeholders = [...JSON.stringify([record.args, record.env, record.url, record.headers]).matchAll(/\$\{([^}]+)\}/g)];
  if (placeholders.some((match) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(match[1]))) throw new Error("Unsupported MCP placeholder: use ${ENV_NAME}, not editor-specific input references.");
  const missingEnvironment = [...new Set(references.filter((name) => environment[name] === undefined || environment[name] === ""))];
  const privateValues = Object.values(interpolateRecord(stringRecord(transport === "stdio" ? record.env : record.headers, 96), environment));
  const redactValues = [...new Set([...references.map((name) => String(environment[name] || "")), ...privateValues, ...privateValues.map((value) => value.replace(/^Bearer\s+/i, ""))].filter((value) => value.length >= 4))];
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
      // argv is an ordered sequence: repeated flags, empty strings and spaces are meaningful.
      args: (() => {
        if (record.args !== undefined && !Array.isArray(record.args)) throw new Error("MCP args must be an array.");
        if ((record.args?.length || 0) > 64) throw new Error("MCP args exceed the 64 argument limit.");
        return (record.args || []).map((item) => {
          if (typeof item !== "string" || item.includes("\0")) throw new Error("MCP arguments must be strings without NUL.");
          return interpolateEnvironment(item, environment);
        });
      })(),
      cwd: String(record.cwd || "").trim().slice(0, 2_000),
      env: interpolateRecord(stringRecord(record.env, 96), environment),
      autoApproveReadOnly,
      timeoutMs,
      missingEnvironment,
      redactValues,
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
  redactValues.push(...[...url.searchParams.values()].filter((value) => value.length >= 4));
  return Object.freeze({
    id,
    name: String(record.name || id).trim().slice(0, 120),
    transport,
    enabled,
    url: url.toString(),
    headers: interpolateRecord(stringRecord(record.headers, 96), environment),
    autoApproveReadOnly,
    timeoutMs,
    missingEnvironment,
    redactValues,
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
    configurationStatus: server.missingEnvironment?.length ? "needs-environment" : server.enabled ? "configured-not-tested" : "disabled",
    missingEnvironment: [...(server.missingEnvironment || [])],
    ...(server.transport === "stdio"
      ? {
          command: server.command,
          argCount: server.args?.length || 0,
          cwd: server.cwd || "",
          envKeys: Object.keys(server.env || {}),
        }
      : {
          url: (() => {
            const publicUrl = new URL(server.url);
            publicUrl.search = "";
            publicUrl.hash = "";
            return publicUrl.toString();
          })(),
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
  const errors = rawServers.length > 64 ? ["MCP config exceeds 64 entries; extra entries were not loaded."] : [];
  const seen = new Set();
  for (const raw of rawServers.slice(0, 64)) {
    try {
      const server = normalizeMcpServer(raw, { environment });
      if (seen.has(server.id)) throw new Error(`Duplicate MCP server id: ${server.id}`);
      seen.add(server.id);
      normalized.push(server);
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

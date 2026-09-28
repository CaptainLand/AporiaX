import path from "node:path";

function absolutePath(value, label) {
  // Accept native Windows paths when generating configs in a cross-platform
  // packaging/test environment. All three paths are supplied by the desktop.
  if (typeof value !== "string" || !(path.isAbsolute(value) || path.win32.isAbsolute(value)) || /[\x00-\x1f]/.test(value)) {
    throw new Error(`${label} must be an absolute path without control characters.`);
  }
  return value;
}

// JSON string escaping is also suitable for these TOML basic strings: paths
// are constrained above, and JSON's remaining escape sequences are TOML-safe.
export function getClientConfiguration({ execPath, bridgePath, connectionPath }) {
  const command = absolutePath(execPath, "Executable");
  const args = [absolutePath(bridgePath, "Bridge"), "mcp", "--connection", absolutePath(connectionPath, "Connection")];
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  const entry = { command, args, env };
  const mcpConfig = { mcpServers: { aporiax: entry } };
  const codexToml = [
    "[mcp_servers.aporiax]",
    `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify(args)}`,
    "",
    "[mcp_servers.aporiax.env]",
    'ELECTRON_RUN_AS_NODE = "1"',
    "",
  ].join("\n");
  return { command, args, env, mcpConfig, claudeDesktopConfig: mcpConfig, codexToml };
}

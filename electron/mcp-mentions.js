import { parseMentionTokens } from "../shared/mention-tokens.js";
import { resolve } from "node:path";
import { isHumanMessage } from "./runtime/task-conversation.js";

// Installed by the trusted main process, never supplied by a renderer message.
let steeringProvider = null;
export function installMcpSteeringProvider(provider) { steeringProvider = provider; }
export async function resolveMcpSteering(request, currentServers = []) {
  if (steeringProvider) return steeringProvider(request, currentServers);
  return { servers: currentServers, unresolved: [] };
}

export function recoveryMcpServerIds(recoveryContext, workspaceRoot) {
  const saved = recoveryContext?.contexts?.[recoveryContext.runId];
  if (saved?.kind !== "main") return [];
  const canonical = root => root ? (process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root)) : "";
  if (canonical(saved.workspaceRoot) !== canonical(workspaceRoot)) throw new Error("RECOVERY_WORKSPACE_MISMATCH");
  // Only identities are durable. Resolve credentials, enabled state and scope
  // afresh through the trusted main-process provider. Migrate older journals
  // from actual user messages, never from tool/retrieval content.
  const ids = Array.isArray(saved.selectedMcpServerIds) ? saved.selectedMcpServerIds
    : (saved.inputHistory || saved.conversation || []).filter(isHumanMessage)
      .flatMap(message => parseMcpMentions(message.workspaceMentionOriginalContent || message.skillOriginalContent || message.content));
  return [...new Set(ids.filter(id => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)).map(id => id.toLowerCase()))].slice(0, 32);
}

export function parseMcpMentions(text) {
  return [...new Set(parseMentionTokens(text).filter((token) => token.kind === "mcp").map((token) => token.value))].slice(0, 16);
}

export function selectConfiguredMcpServers(request, currentServers, configuredServers) {
  const mentions = [...new Set((request.messages || []).filter(isHumanMessage).flatMap(message =>
    parseMcpMentions(message.workspaceMentionOriginalContent || message.skillOriginalContent || message.content)))];
  const restoredIds = (request.selectedIds || []).filter(id => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)).slice(0, 32).map(id => id.toLowerCase());
  const selected = new Set([...currentServers.map(server => server.id), ...mentions, ...restoredIds]);
  const servers = configuredServers.filter(server => server.enabled !== false && selected.has(server.id));
  const available = new Set(servers.map(server => server.id));
  return { servers, unresolved: [...new Set([...mentions, ...restoredIds].filter(id => !available.has(id)))],
    retryServerIds: mentions.filter(id => available.has(id)) };
}

function activePrompt(request = {}) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const source = request.sourceUserId
    ? messages.find((message) => message?.role === "user" && message?.id === request.sourceUserId)
    : [...messages].reverse().find((message) => message?.role === "user");
  return String(
    source?.workspaceMentionOriginalContent ||
      source?.skillOriginalContent ||
      source?.content ||
      request.prompt ||
      "",
  );
}

export function selectMentionedMcpServers(request, servers = []) {
  const mentions = parseMcpMentions(activePrompt(request));
  if (!mentions.length) return { servers, mentions: [], unresolved: [] };
  const byId = new Map((servers || []).map((server) => [String(server.id).toLowerCase(), server]));
  return {
    servers: mentions.map((id) => byId.get(id)).filter(Boolean),
    mentions,
    unresolved: mentions.filter((id) => !byId.has(id)),
  };
}

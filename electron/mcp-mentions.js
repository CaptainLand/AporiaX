export function parseMcpMentions(text) {
  const ids = [];
  const pattern = /(?:^|\s)@mcp(?::|\s+)([a-z][a-z0-9_-]{1,47})(?=\s|$)/gi;
  for (const match of String(text || "").matchAll(pattern)) {
    const id = String(match[1] || "").toLowerCase();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 16);
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

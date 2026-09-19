import { createHash } from "node:crypto";
import { providerMessages } from "./task-conversation.js";

// Deterministic schema order, unchanged instructions/history and no mutation of
// the caller's records. Cache reuse is measured, not guaranteed by this helper.
export function compileModelRequest(body) {
  if (!body || typeof body !== "object") throw new TypeError("Model request body is required.");
  const tools = Array.isArray(body.tools) ? [...body.tools].sort((a, b) => {
    const left = String(a?.function?.name || ""), right = String(b?.function?.name || "");
    return left < right ? -1 : left > right ? 1 : 0;
  }) : null;
  return { ...body, ...(Array.isArray(body.messages) ? { messages: providerMessages(body.messages) } : {}),
    ...(tools ? { tools } : {}) };
}

export function requestFingerprint(body) {
  const compiled = compileModelRequest(body);
  const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { model: compiled.model, toolSchemaHash: hash(compiled.tools || []),
    messageHashes: (compiled.messages || []).map(hash) };
}

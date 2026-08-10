import { mkdir, readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

let core = await readFile("electron/agent-runtime-core.js", "utf8");
const startMarker = `function appendToolCallDelta(toolCalls, incomingCall) {`;
const endMarker = `function buildChanges(changeMap) {`;
const start = core.indexOf(startMarker);
const end = core.indexOf(endMarker, start + startMarker.length);
if (start < 0 || end < 0) throw new Error("provider stream section anchors not found");
let providerSection = core.slice(start, end).trimEnd();
providerSection = providerSection
  .replace(
    `async function callModelProvider({`,
    `export async function callModelProvider({`,
  )
  .replace(
    `function createOpenAICompatibleProvider({`,
    `export function createOpenAICompatibleProvider({`,
  )
  .replace(
    `async function callModelProviderOnce({`,
    `export async function callModelProviderOnce({`,
  );

await mkdir("electron/runtime", { recursive: true });
await writeFile(
  "electron/runtime/provider-stream.js",
  `import { providerChatEndpoint } from "../provider-config.js";\n\nconst PROVIDER_IDLE_TIMEOUT_MS = 180_000;\nconst PROVIDER_MAX_ATTEMPTS = 3;\n\nfunction createAbortError(message = "The run was interrupted.") {\n  const error = new Error(message);\n  error.name = "AbortError";\n  return error;\n}\n\nfunction throwIfAborted(signal) {\n  if (signal?.aborted) throw createAbortError();\n}\n\n${providerSection}\n`,
  "utf8",
);

core = `${core.slice(0, start)}${core.slice(end)}`;
core = replaceOnce(
  core,
  `const PROVIDER_IDLE_TIMEOUT_MS = 180_000;\nconst PROVIDER_MAX_ATTEMPTS = 3;\n`,
  ``,
  "provider constants",
);
core = replaceOnce(
  core,
  `import { providerChatEndpoint } from "./provider-config.js";\n`,
  `import { createOpenAICompatibleProvider } from "./runtime/provider-stream.js";\n`,
  "provider stream import",
);
await writeFile("electron/agent-runtime-core.js", core, "utf8");

await rm("scripts/apply-v06-provider-stream.mjs", { force: true });
await rm(".github/workflows/apply-v06-provider-stream.yml", { force: true });
console.log("provider streaming extraction applied");

import { readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

function replaceSection(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const endStart = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || endStart < 0) throw new Error(`${label}: missing section anchor`);
  if (source.indexOf(startMarker, start + 1) >= 0) throw new Error(`${label}: duplicate start anchor`);
  return `${source.slice(0, start)}${replacement}${source.slice(endStart)}`;
}

let runtime = await readFile("electron/agent-runtime-core.js", "utf8");
runtime = replaceOnce(
  runtime,
  `import {\n  buildToolApprovalRequest,\n  resolveToolExecutionPermission,\n} from "./runtime/tool-permissions.js";\n`,
  `import {\n  dispatchNativeTool,\n  projectNativeToolCatalog,\n} from "./runtime/tool-dispatcher.js";\n`,
  "dispatcher import",
);

runtime = replaceSection(
  runtime,
  `async function executeTool({\n  toolCall,\n  workspaceRoot,\n  permissionPolicy,\n  approvalMode = "manual",\n  requestApproval,\n  signal,\n  sandboxExecutor = runCommandWithFallback,\n  sandboxStatus = null,\n  browserRuntime = null,\n}) {\n  throwIfAborted(signal);\n  const toolName = toolCall.function.name;\n  const descriptor = TOOL_REGISTRY.get(toolName);\n  if (!descriptor) {\n    throw new Error(\`Unsupported tool: \${toolName}\`);\n  }\n  const input = parseToolArguments(toolCall);\n`,
  `\n  if (isBrowserToolName(toolName)) {`,
  `async function executeAuthorizedTool({\n  toolCall,\n  toolName = toolCall.function.name,\n  input,\n  workspaceRoot,\n  signal,\n  sandboxExecutor = runCommandWithFallback,\n  sandboxStatus = null,\n  browserRuntime = null,\n}) {\n  throwIfAborted(signal);\n`,
  "native executor authorization removal",
);

runtime = replaceSection(
  runtime,
  `  const staticToolCatalog = hasWorkspace\n`,
  `  const toolCatalog = [...staticToolCatalog, ...(mcpDiscovery.tools || [])];`,
  `  const staticToolCatalog = hasWorkspace\n    ? projectNativeToolCatalog({\n        catalog: TOOL_REGISTRY.catalog(permissionPolicy),\n        approvalMode: effectiveApprovalMode,\n        sandboxStatus,\n      })\n    : [];\n`,
  "catalog projection",
);

const oldCall = `executeTool({\n                  toolCall,\n                  workspaceRoot,\n                  permissionPolicy,\n                  approvalMode: effectiveApprovalMode,\n                  requestApproval,\n                  signal,\n                  sandboxExecutor,\n                  sandboxStatus,\n                })`;
const newCall = `dispatchNativeTool({\n                  toolCall,\n                  registry: TOOL_REGISTRY,\n                  permissionPolicy,\n                  approvalMode: effectiveApprovalMode,\n                  requestApproval,\n                  sandboxStatus,\n                  signal,\n                  parseArguments: parseToolArguments,\n                  executeAuthorized: executeAuthorizedTool,\n                  executeContext: {\n                    workspaceRoot,\n                    sandboxExecutor,\n                    sandboxStatus,\n                    browserRuntime,\n                  },\n                })`;
runtime = replaceOnce(runtime, oldCall, newCall, "parallel native dispatch");

const oldSequentialCall = `executeTool({\n              toolCall,\n              workspaceRoot,\n              permissionPolicy,\n              approvalMode: effectiveApprovalMode,\n              requestApproval,\n              signal,\n              sandboxExecutor,\n              sandboxStatus,\n              browserRuntime,\n            })`;
const newSequentialCall = `dispatchNativeTool({\n              toolCall,\n              registry: TOOL_REGISTRY,\n              permissionPolicy,\n              approvalMode: effectiveApprovalMode,\n              requestApproval,\n              sandboxStatus,\n              signal,\n              parseArguments: parseToolArguments,\n              executeAuthorized: executeAuthorizedTool,\n              executeContext: {\n                workspaceRoot,\n                sandboxExecutor,\n                sandboxStatus,\n                browserRuntime,\n              },\n            })`;
runtime = replaceOnce(runtime, oldSequentialCall, newSequentialCall, "sequential native dispatch");

await writeFile("electron/agent-runtime-core.js", runtime, "utf8");

let pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:tool-dispatcher"] = "node tests/tool-dispatcher-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-tool-dispatcher-refactor.mjs", { force: true });
await rm(".github/workflows/validate-tool-dispatcher.yml", { force: true });
console.log("tool dispatcher refactor applied");

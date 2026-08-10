import { readFile, writeFile } from "node:fs/promises";

const runtime = await readFile("electron/agent-runtime-core.js", "utf8");
const main = await readFile("src/main.jsx", "utf8");
const checks = {
  browserImport: `} from "./browser-runtime.js";\nimport {\n  createProjectUnderstandingStore,`,
  runOptions: `  memoryDirectory = null,\n  understandingDirectory = null,\n}) {`,
  scopedLoop: `    for (const toolCall of toolCalls || []) {\n      const paths = requestedPathsForToolCall(toolCall);`,
  toolCatalogStart: `  const toolCatalog = hasWorkspace\n    ? TOOL_REGISTRY.catalog(permissionPolicy).map((tool) =>`,
  toolCatalogEnd: `  const browserRuntime = createBrowserRuntime();\n  witness = createWitnessMonitor({ emit: forwardEvent });`,
  turnMetadata: `    tools: toolCatalog,\n    sandbox: sandboxStatus,\n  });`,
  promptSafety: `        "Use browser_open and browser_snapshot when the task requires checking a running web page. Prefer semantic browser locators. Treat browser_click, browser_fill, and browser_press as potentially state-changing actions and never claim a page was verified without observing the resulting snapshot, console, or network evidence.",\n        "For work that needs more than one meaningful action, call update_plan before changing files.`,
  toolExposure: `          ...(hasWorkspace && provider.supportsTools\n            ? {\n                tools: enabledToolDefinitions,\n                tool_choice: "auto",\n              }\n            : {}),`,
  dispatch: `          if (toolCall.function.name === "delegate_subagent") {\n            result = {`,
  teardown: `  } finally {\n    await browserRuntime.close().catch(() => undefined);\n    witness?.dispose();`,
  mainStatus: `          title: toolLabels[event.tool] || tr("Harness 正在运行", "Harness is running"),`,
};
const counts = {};
for (const [name, needle] of Object.entries(checks)) {
  const source = name === "mainStatus" ? main : runtime;
  counts[name] = source.split(needle).length - 1;
}
await writeFile("mcp-patch-diagnostics.json", `${JSON.stringify(counts, null, 2)}\n`, "utf8");
console.log(counts);

import { readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

let runtime = await readFile("electron/agent-runtime-core.js", "utf8");
const startMarker = `const TOOL_DEFINITIONS = [\n`;
const endMarker = `\nfunction createAbortError(message = "The run was interrupted.") {\n`;
const start = runtime.indexOf(startMarker);
const end = runtime.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error("tool catalog anchors not found");
const catalogBlock = runtime.slice(start, end);
if (!catalogBlock.includes("const TOOL_RISKS = {") || !catalogBlock.includes("const TOOL_REGISTRY = new ToolRegistry(")) {
  throw new Error("tool catalog block is incomplete");
}

let moduleBlock = catalogBlock
  .replace("const TOOL_DEFINITIONS = [", "export const TOOL_DEFINITIONS = [")
  .replace("const TOOL_RISKS = {", "export const TOOL_RISKS = {")
  .replace("const TOOL_REGISTRY = new ToolRegistry(", "export const TOOL_REGISTRY = new ToolRegistry(")
  .replace('required: ["command", "cwd", "reason"],', 'required: ["command", "cwd"],');

const moduleSource = `import { ToolRegistry } from "../agent-core.js";\nimport { OFFICE_TOOL_DEFINITIONS } from "../office-tools.js";\nimport { BROWSER_TOOL_DEFINITIONS, BROWSER_TOOL_RISKS } from "../browser-runtime.js";\nimport { MAX_SUBAGENT_ROUNDS } from "./subagent-model.js";\n\nexport const MAX_SEARCH_RESULTS = 200;\n\n${moduleBlock}\n`;
await writeFile("electron/runtime/native-tool-catalog.js", moduleSource, "utf8");

runtime = `${runtime.slice(0, start)}${runtime.slice(end + 1)}`;
runtime = replaceOnce(
  runtime,
  `import {\n  ToolRegistry,\n  createEventEmitter,\n  createPermissionPolicy,\n  getToolPermission,\n} from "./agent-core.js";\n`,
  `import {\n  createEventEmitter,\n  createPermissionPolicy,\n  getToolPermission,\n} from "./agent-core.js";\n`,
  "remove ToolRegistry import",
);
runtime = replaceOnce(
  runtime,
  `import { createSelfCheckCoordinator } from "./runtime/self-check-coordinator.js";\n`,
  `import { createSelfCheckCoordinator } from "./runtime/self-check-coordinator.js";\nimport {\n  MAX_SEARCH_RESULTS,\n  TOOL_REGISTRY,\n} from "./runtime/native-tool-catalog.js";\n`,
  "native tool catalog import",
);
runtime = replaceOnce(runtime, `const MAX_SEARCH_RESULTS = 200;\n`, ``, "search result constant");
await writeFile("electron/agent-runtime-core.js", runtime, "utf8");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:native-tool-catalog"] = "node tests/native-tool-catalog-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-native-tool-catalog-refactor.mjs", { force: true });
await rm(".github/workflows/validate-native-tool-catalog.yml", { force: true });
console.log("native tool catalog extraction applied");

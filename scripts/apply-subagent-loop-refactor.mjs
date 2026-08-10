import { readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

function removeSection(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`${label}: missing section anchor`);
  if (source.indexOf(startMarker, start + 1) >= 0) throw new Error(`${label}: duplicate start anchor`);
  return `${source.slice(0, start)}${source.slice(end)}`;
}

let runtime = await readFile("electron/agent-runtime-core.js", "utf8");
runtime = replaceOnce(
  runtime,
  `import {\n  MAX_SUBAGENT_RESULT_CHARS,\n  MAX_SUBAGENT_ROUNDS,\n  SUBAGENT_ROLE_CONFIG,\n  assertSubagentScope,\n  compactSubagentEvidence,\n  compactSubagentModelResult,\n  createSubagentPermissionPolicy,\n  normalizeSubagentInput,\n  normalizeWorkspaceScope,\n  subagentEvidence,\n  subagentToolPaths,\n  subagentToolsAreParallel,\n} from "./runtime/subagent-model.js";\n`,
  `import {\n  MAX_SUBAGENT_ROUNDS,\n  normalizeSubagentInput,\n  normalizeWorkspaceScope,\n} from "./runtime/subagent-model.js";\nimport { runSubagentTask } from "./runtime/subagent-loop.js";\n`,
  "subagent loop import",
);

runtime = removeSection(
  runtime,
  `async function runSubagentTask({\n`,
  `function mainToolBatchCanRunInParallel(toolCalls) {\n`,
  "subagent model loop",
);

runtime = replaceOnce(
  runtime,
  `      memoryFacts: relevantMemory,\n      emit,\n    })`,
  `      memoryFacts: relevantMemory,\n      emit,\n      toolRegistry: TOOL_REGISTRY,\n      parseToolArguments,\n      executeAuthorizedTool,\n      describeToolActivity,\n    })`,
  "subagent dependency injection",
);

await writeFile("electron/agent-runtime-core.js", runtime, "utf8");

let pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:subagent-loop"] = "node tests/subagent-loop-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-subagent-loop-refactor.mjs", { force: true });
await rm(".github/workflows/validate-subagent-loop.yml", { force: true });
console.log("subagent loop extraction applied");

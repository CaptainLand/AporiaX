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
  `import {\n  buildChanges,\n  buildSelfCheckResult,\n  createChangeVersionSignature,\n  createProgressiveReviewTask,\n  createProgressiveVerifyTask,\n  createSelfCheckPrompt,\n  findVerificationCandidate,\n  getPendingSelfCheckPaths,\n  normalizeSelfCheckReport,\n  parseProgressiveReviewReport,\n  reviewableChanges,\n} from "./runtime/self-check-evidence.js";\nexport { getPendingSelfCheckPaths } from "./runtime/self-check-evidence.js";\n`,
  `import {\n  buildChanges,\n  buildSelfCheckResult,\n  createChangeVersionSignature,\n  createProgressiveReviewTask,\n  createProgressiveVerifyTask,\n  createSelfCheckPrompt,\n  findVerificationCandidate,\n  getPendingSelfCheckPaths,\n  normalizeSelfCheckReport,\n  parseProgressiveReviewReport,\n  reviewableChanges,\n} from "./runtime/self-check-evidence.js";\nimport {\n  MAX_SUBAGENT_RESULT_CHARS,\n  MAX_SUBAGENT_ROUNDS,\n  SUBAGENT_ROLE_CONFIG,\n  assertSubagentScope,\n  compactSubagentEvidence,\n  compactSubagentModelResult,\n  createSubagentPermissionPolicy,\n  normalizeSubagentInput,\n  normalizeWorkspaceScope,\n  subagentEvidence,\n  subagentToolPaths,\n  subagentToolsAreParallel,\n} from "./runtime/subagent-model.js";\nexport { getPendingSelfCheckPaths } from "./runtime/self-check-evidence.js";\n`,
  "subagent model import",
);

runtime = replaceOnce(
  runtime,
  `const DEFAULT_SUBAGENT_ROUNDS = 8;\nconst MAX_SUBAGENT_ROUNDS = 20;\nconst MAX_SUBAGENT_TASK_CHARS = 4_000;\nconst MAX_SUBAGENT_RESULT_CHARS = 24_000;\nconst MAX_SUBAGENT_EVIDENCE_CHARS = 24_000;\n`,
  ``,
  "subagent constants",
);

runtime = removeSection(
  runtime,
  `const SUBAGENT_ROLE_CONFIG = Object.freeze({\n`,
  `const PARALLEL_MAIN_TOOLS = new Set([\n`,
  "subagent role config",
);

runtime = removeSection(
  runtime,
  `function normalizeWorkspaceScope(values) {\n`,
  `function normalizeUnderstandingCategory(category) {\n`,
  "subagent input normalization",
);

runtime = removeSection(
  runtime,
  `function subagentToolPaths(toolName, input) {\n`,
  `function requestedPathsForToolCall(toolCall) {\n`,
  "subagent tool path helper",
);

runtime = removeSection(
  runtime,
  `function pathIsInsideScope(path, scope) {\n`,
  `async function mapWithConcurrency(items, limit, worker) {\n`,
  "subagent scope/evidence helpers",
);

runtime = removeSection(
  runtime,
  `function subagentToolsAreParallel(toolCalls) {\n`,
  `async function runSubagentTask({\n`,
  "subagent parallel helper",
);

await writeFile("electron/agent-runtime-core.js", runtime, "utf8");

let pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:subagent-model"] = "node tests/subagent-model-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-subagent-model-refactor.mjs", { force: true });
await rm(".github/workflows/validate-subagent-model.yml", { force: true });
console.log("subagent model extraction applied");

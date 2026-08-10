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
  `import {\n  dispatchNativeTool,\n  projectNativeToolCatalog,\n} from "./runtime/tool-dispatcher.js";\n`,
  `import {\n  dispatchNativeTool,\n  projectNativeToolCatalog,\n} from "./runtime/tool-dispatcher.js";\nimport {\n  buildChanges,\n  buildSelfCheckResult,\n  createChangeVersionSignature,\n  createProgressiveReviewTask,\n  createProgressiveVerifyTask,\n  createSelfCheckPrompt,\n  findVerificationCandidate,\n  getPendingSelfCheckPaths,\n  normalizeSelfCheckReport,\n  parseProgressiveReviewReport,\n  reviewableChanges,\n} from "./runtime/self-check-evidence.js";\n`,
  "self-check evidence import",
);

runtime = removeSection(
  runtime,
  `export function getPendingSelfCheckPaths(\n`,
  `function normalizeExecutionPlan(`,
  "pending/self-check normalization helpers",
);

runtime = removeSection(
  runtime,
  `function buildChanges(changeMap) {\n`,
  `async function discoverVerificationCommands(`,
  "self-check evidence model helpers",
);

runtime = removeSection(
  runtime,
  `function createSelfCheckPrompt(\n`,
  `function sanitizeFinalAnswer(`,
  "self-check prompt and candidate helpers",
);

await writeFile("electron/agent-runtime-core.js", runtime, "utf8");

let pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:self-check-evidence"] = "node tests/self-check-evidence-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-self-check-evidence-refactor.mjs", { force: true });
await rm(".github/workflows/validate-self-check-evidence.yml", { force: true });
console.log("self-check evidence extraction applied");

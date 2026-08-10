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
  `import { createNativeToolExecutor } from "./runtime/native-tool-executor.js";\n`,
  `import { createNativeToolExecutor } from "./runtime/native-tool-executor.js";\nimport {\n  MAX_COMMAND_OUTPUT_CHARS,\n  TREE_IGNORES,\n  calculateLineChanges,\n  getVerifiedWorkspaceRoot,\n  isPathInside,\n  resolveWorkspacePath,\n  runGitCommand,\n  searchWorkspaceText,\n  verifyExistingTarget,\n  verifyWritableTarget,\n} from "./runtime/workspace-runtime.js";\n`,
  "workspace runtime import",
);

runtime = replaceOnce(runtime, `const MAX_COMMAND_OUTPUT_CHARS = 80_000;\n`, ``, "command output constant");
runtime = replaceOnce(runtime, `const MAX_SEARCH_FILE_BYTES = 2_000_000;\n`, ``, "search file constant");
runtime = replaceOnce(
  runtime,
  `const TREE_IGNORES = new Set([\n  ".git",\n  ".idea",\n  ".next",\n  ".turbo",\n  ".vscode",\n  "coverage",\n  "dist",\n  "node_modules",\n]);\n`,
  ``,
  "tree ignores",
);

runtime = removeSection(
  runtime,
  `function isPathInside(rootPath, candidatePath) {\n`,
  `function anchorFileLimit(path) {\n`,
  "workspace path safety helpers",
);

runtime = removeSection(
  runtime,
  `function calculateLineChanges(previousContent, nextContent) {\n`,
  `function mergeFileChange(changeMap, change) {\n`,
  "line change helper",
);

runtime = removeSection(
  runtime,
  `function trimCommandOutput(value) {\n`,
  `const executeAuthorizedTool = createNativeToolExecutor({\n`,
  "git and search helpers",
);

await writeFile("electron/agent-runtime-core.js", runtime, "utf8");

let pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:workspace-runtime"] = "node tests/workspace-runtime-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-workspace-runtime-refactor.mjs", { force: true });
await rm(".github/workflows/validate-workspace-runtime.yml", { force: true });
console.log("workspace runtime extraction applied");

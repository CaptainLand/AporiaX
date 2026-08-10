import { readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

function replaceSection(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`${label}: missing section anchor`);
  if (source.indexOf(startMarker, start + 1) >= 0) throw new Error(`${label}: duplicate start anchor`);
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

let runtime = await readFile("electron/agent-runtime-core.js", "utf8");
runtime = replaceOnce(
  runtime,
  `import { runSubagentTask } from "./runtime/subagent-loop.js";\n`,
  `import { runSubagentTask } from "./runtime/subagent-loop.js";\nimport { createNativeToolExecutor } from "./runtime/native-tool-executor.js";\n`,
  "native executor import",
);

runtime = replaceSection(
  runtime,
  `function countExactOccurrences(content, searchText) {\n`,
  `function normalizeImageAttachment(attachment) {\n`,
  `const executeAuthorizedTool = createNativeToolExecutor({\n  verifyExistingTarget,\n  verifyWritableTarget,\n  searchWorkspaceText,\n  calculateLineChanges,\n  runGitCommand,\n  limits: {\n    maxFileReadChars: MAX_FILE_READ_CHARS,\n    maxFileWriteChars: MAX_FILE_WRITE_CHARS,\n    maxDirectoryEntries: MAX_DIRECTORY_ENTRIES,\n    maxCommandChars: MAX_COMMAND_CHARS,\n    maxCommandOutputChars: MAX_COMMAND_OUTPUT_CHARS,\n    maxSearchResults: MAX_SEARCH_RESULTS,\n    maxPatchTextChars: MAX_PATCH_TEXT_CHARS,\n    maxGitDiffChars: MAX_GIT_DIFF_CHARS,\n  },\n});\n\n`,
  "native tool implementation",
);

await writeFile("electron/agent-runtime-core.js", runtime, "utf8");

let pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:native-tool-executor"] = "node tests/native-tool-executor-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-native-tool-executor-refactor.mjs", { force: true });
await rm(".github/workflows/validate-native-tool-executor.yml", { force: true });
console.log("native tool executor extraction applied");

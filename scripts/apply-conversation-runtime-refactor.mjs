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
  `import {\n  MAX_COMMAND_OUTPUT_CHARS,\n  TREE_IGNORES,\n  calculateLineChanges,\n  getVerifiedWorkspaceRoot,\n  isPathInside,\n  resolveWorkspacePath,\n  runGitCommand,\n  searchWorkspaceText,\n  verifyExistingTarget,\n  verifyWritableTarget,\n} from "./runtime/workspace-runtime.js";\n`,
  `import {\n  MAX_COMMAND_OUTPUT_CHARS,\n  TREE_IGNORES,\n  calculateLineChanges,\n  getVerifiedWorkspaceRoot,\n  isPathInside,\n  resolveWorkspacePath,\n  runGitCommand,\n  searchWorkspaceText,\n  verifyExistingTarget,\n  verifyWritableTarget,\n} from "./runtime/workspace-runtime.js";\nimport {\n  formatToolStepDetail,\n  sanitizeConversation,\n  sanitizeFinalAnswer,\n} from "./runtime/conversation.js";\nexport { sanitizeConversation } from "./runtime/conversation.js";\n`,
  "conversation runtime import",
);
runtime = replaceOnce(runtime, `const MAX_HISTORY_MESSAGES = 30;\n`, ``, "history constant");

runtime = removeSection(
  runtime,
  `function normalizeImageAttachment(attachment) {\n`,
  `async function loadProjectConfig(workspaceRoot) {\n`,
  "conversation sanitization helpers",
);

runtime = removeSection(
  runtime,
  `function sanitizeFinalAnswer(content) {\n`,
  `const PARALLEL_MAIN_TOOLS = new Set([\n`,
  "final answer/tool detail helpers",
);

await writeFile("electron/agent-runtime-core.js", runtime, "utf8");

let pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:conversation-runtime"] = "node tests/conversation-runtime-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-conversation-runtime-refactor.mjs", { force: true });
await rm(".github/workflows/validate-conversation-runtime.yml", { force: true });
console.log("conversation runtime extraction applied");

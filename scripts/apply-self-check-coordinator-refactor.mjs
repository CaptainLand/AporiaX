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
  `import {\n  formatToolStepDetail,\n  sanitizeConversation,\n  sanitizeFinalAnswer,\n} from "./runtime/conversation.js";\n`,
  `import {\n  formatToolStepDetail,\n  sanitizeConversation,\n  sanitizeFinalAnswer,\n} from "./runtime/conversation.js";\nimport { createSelfCheckCoordinator } from "./runtime/self-check-coordinator.js";\n`,
  "self-check coordinator import",
);
runtime = replaceOnce(
  runtime,
  `  let progressiveReviewJob = null;\n`,
  ``,
  "progressive review job state",
);

runtime = replaceSection(
  runtime,
  `  const runProgressiveSelfCheckSegment = async ({\n`,
  `  const collectSubagents = async (rawInput = {}) => {\n`,
  `  const selfCheckCoordinator = createSelfCheckCoordinator({\n    selfCheck,\n    changeMap,\n    language,\n    emit,\n    startSubagent,\n    commandToolAvailable,\n    discoverVerificationCommands,\n    workspaceRoot,\n  });\n  const runProgressiveSelfCheckSegment = selfCheckCoordinator.runSegment;\n  const scheduleProgressiveSelfCheckSegment = selfCheckCoordinator.scheduleSegment;\n  const consumeProgressiveReviewJob = selfCheckCoordinator.consumeReviewJob;\n  const sealProgressiveSelfCheck = selfCheckCoordinator.seal;\n\n`,
  "progressive self-check coordinator block",
);

await writeFile("electron/agent-runtime-core.js", runtime, "utf8");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:self-check-coordinator"] = "node tests/self-check-coordinator-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-self-check-coordinator-refactor.mjs", { force: true });
await rm(".github/workflows/validate-self-check-coordinator.yml", { force: true });
console.log("self-check coordinator extraction applied");

import { readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  }
  return source.replace(before, after);
}

function removeSection(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`${label}: missing section anchor`);
  return `${source.slice(0, start)}${source.slice(end)}`;
}

let main = await readFile("src/main.jsx", "utf8");
main = replaceOnce(
  main,
  `import "./styles.css";`,
  `import {\n  AgentProcessTrace,\n  FoldableUserPrompt,\n  LiveAgentStatus,\n  RunDurationChip,\n} from "./conversation/RuntimeMessageUI";\nimport "./styles.css";`,
  "conversation runtime import",
);
main = replaceOnce(
  main,
  `        </strong>\n        {hasAnchor && (`,
  `        </strong>\n        <RunDurationChip message={message} />\n        {hasAnchor && (`,
  "native duration chip",
);
main = replaceOnce(
  main,
  `      </div>\n      <div className="assistant-message-content">\n        {restored ? (`,
  `      </div>\n      <LiveAgentStatus message={message} />\n      <div className="assistant-message-content">\n        {restored ? (`,
  "native live status",
);
main = replaceOnce(
  main,
  `        ) : (\n          <span className="stream-placeholder">{tr("正在生成回复…", "Generating a response…")}</span>\n        )}\n      </div>\n      {(failed || interrupted) && message.prompt && (`,
  `        ) : message.status === "running" ? null : (\n          <span className="stream-placeholder">{tr("暂无回复内容", "No response content")}</span>\n        )}\n      </div>\n      <AgentProcessTrace message={message} />\n      {(failed || interrupted) && message.prompt && (`,
  "native agent process",
);
main = replaceOnce(
  main,
  `            {message.content && (\n              <div className="message-bubble">{message.content}</div>\n            )}`,
  `            {message.content && (\n              <FoldableUserPrompt content={message.content} />\n            )}`,
  "native prompt folding",
);
await writeFile("src/main.jsx", main, "utf8");

let enhancements = await readFile("src/runtime-ui-enhancements.jsx", "utf8");
enhancements = replaceOnce(
  enhancements,
  `  ArrowRight,\n  Check,\n  Eye,\n  FileText,\n  ImagePlus,\n  LoaderCircle,\n  Terminal,`,
  `  ArrowRight,\n  Eye,\n  FileText,\n  ImagePlus,\n  LoaderCircle,`,
  "legacy enhancement icons",
);
enhancements = replaceOnce(
  enhancements,
  `import {\n  buildAgentProcessSummary,\n  currentProcessSummary,\n  extractWorkspaceMentionQuery,\n  rankWorkspaceFiles,\n  replaceWorkspaceMentionQuery,\n} from "./agent-process-model.js";`,
  `import {\n  extractWorkspaceMentionQuery,\n  rankWorkspaceFiles,\n  replaceWorkspaceMentionQuery,\n} from "./agent-process-model.js";`,
  "legacy enhancement model imports",
);
enhancements = replaceOnce(
  enhancements,
  `import {\n  formatTaskDuration,\n  readTaskListFromStorage,\n  resolveVisionCapability,\n  selectVisibleTask,\n} from "./runtime-ui-core.js";`,
  `import {\n  readTaskListFromStorage,\n  resolveVisionCapability,\n  selectVisibleTask,\n} from "./runtime-ui-core.js";`,
  "legacy runtime imports",
);
enhancements = replaceOnce(
  enhancements,
  `const durationRoots = new Map();\nconst processRoots = new Map();\n`,
  ``,
  "legacy runtime roots",
);
enhancements = removeSection(
  enhancements,
  `function RunDurationChip({ message, now }) {`,
  `function capabilityStatusText(capability) {`,
  "legacy conversation islands",
);
enhancements = replaceOnce(
  enhancements,
  `function refreshPresentation() {\n  syncDurationChips();\n  syncProcessTraces();\n  syncVisionCapability();\n  syncComposerMentionBinding();\n}`,
  `function refreshPresentation() {\n  syncVisionCapability();\n  syncComposerMentionBinding();\n}`,
  "legacy presentation refresh",
);
await writeFile("src/runtime-ui-enhancements.jsx", enhancements, "utf8");

let index = await readFile("index.html", "utf8");
index = index.replace(
  `    <script type="module" src="/src/live-agent-status.jsx"></script>\n`,
  "",
);
index = index.replace(
  `    <script type="module" src="/src/prompt-folding.js"></script>\n`,
  "",
);
await writeFile("index.html", index, "utf8");

await rm("scripts/apply-v06-conversation-refactor.mjs", { force: true });
await rm(".github/workflows/apply-v06-conversation-refactor.yml", { force: true });
console.log("v0.6 conversation refactor applied");

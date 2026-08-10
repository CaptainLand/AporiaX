import { mkdir, readFile, writeFile, rm } from "node:fs/promises";

function section(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`${label}: missing section anchor`);
  return source.slice(start, end);
}

function removeSection(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`${label}: missing section anchor`);
  return `${source.slice(0, start)}${source.slice(end)}`;
}

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

let main = await readFile("src/main.jsx", "utf8");

const iconButtonSource = section(
  main,
  "function IconButton(",
  "function AppTitlebar(",
  "IconButton",
);
const modelControlsSource = section(
  main,
  "function ModelChoice(",
  "function NewTaskModal(",
  "model controls",
);
const composerSource = section(
  main,
  "function ModelMenu(",
  "function MarkdownCodeBlock(",
  "Composer",
);
const conversationSource = section(
  main,
  "function MarkdownCodeBlock(",
  "function SettingsPanel(",
  "Conversation and Route",
);
const settingsSource = section(
  main,
  "function SettingsPanel(",
  "function RenameTaskModal(",
  "SettingsPanel",
);

await mkdir("src/components", { recursive: true });
await mkdir("src/composer", { recursive: true });
await mkdir("src/conversation", { recursive: true });
await mkdir("src/settings", { recursive: true });

const controlsModule = `import React from "react";\nimport { Check } from "lucide-react";\nimport { useI18n } from "../i18n";\n\n${iconButtonSource}${modelControlsSource}`
  .replace("function IconButton(", "export function IconButton(")
  .replace("function ModelChoice(", "export function ModelChoice(")
  .replace("function Switch(", "export function Switch(")
  .replace("function SegmentedControl(", "export function SegmentedControl(");
await writeFile("src/components/Controls.jsx", controlsModule, "utf8");

const composerModule = `import React, { useEffect, useRef, useState } from "react";\nimport {\n  ArrowUp,\n  ChevronDown,\n  FileText,\n  ImagePlus,\n  LoaderCircle,\n  Pause,\n  Play,\n  Plus,\n  Square,\n  X,\n} from "lucide-react";\nimport { useI18n } from "../i18n";\nimport { ModelChoice, SegmentedControl, Switch } from "../components/Controls.jsx";\nimport { getAvailableModels, getModel } from "../models/model-catalog.js";\nimport { useWorkspaceMentionAutocomplete } from "./WorkspaceMentionAutocomplete.jsx";\n\n${composerSource}`
  .replace("function Composer(", "export function Composer(");
await writeFile("src/composer/Composer.jsx", composerModule, "utf8");

const conversationModule = `import React, { useEffect, useMemo, useState } from "react";\nimport ReactMarkdown from "react-markdown";\nimport remarkGfm from "remark-gfm";\nimport { diffLines } from "diff";\nimport {\n  AlertTriangle,\n  ArrowRight,\n  Brain,\n  Check,\n  ChevronDown,\n  Copy,\n  Eye,\n  FileCode2,\n  FileText,\n  Files,\n  History,\n  LoaderCircle,\n  Pause,\n  RotateCcw,\n  Search,\n  ShieldCheck,\n  Undo2,\n  X,\n} from "lucide-react";\nimport { ApprovalCard, DiffReviewPanel, UserAttachments } from "../agent-components";\nimport {\n  buildWitnessRouteBlocks,\n  collectTaskRouteRuns,\n  getRouteToolMeta,\n  summarizeRoutePrompt,\n} from "../p0-model";\nimport { useI18n } from "../i18n";\nimport {\n  AgentProcessTrace,\n  FoldableUserPrompt,\n  LiveAgentStatus,\n  RunDurationChip,\n} from "./RuntimeMessageUI.jsx";\n\n${conversationSource}`
  .replace("function Conversation(", "export function Conversation(")
  .replace("function RouteView(", "export function RouteView(");
await writeFile("src/conversation/ConversationViews.jsx", conversationModule, "utf8");

const settingsModule = `import React from "react";\nimport {\n  AlertTriangle,\n  Folder,\n  FolderOpen,\n  LoaderCircle,\n  LockKeyhole,\n  PanelRightClose,\n} from "lucide-react";\nimport { LanguageSwitch, useI18n } from "../i18n";\nimport { IconButton, Switch } from "../components/Controls.jsx";\nimport { TaskCapabilityCards } from "./TaskCapabilityCards.jsx";\n\n${settingsSource}`
  .replace("function SettingsPanel(", "export function SettingsPanel(");
await writeFile("src/settings/SettingsPanel.jsx", settingsModule, "utf8");

// Remove model constants first while keeping readSavedTasks as the boundary.
main = removeSection(
  main,
  "const EMPTY_MODEL = {",
  "function readSavedTasks(",
  "model constants",
);
// Remove model helper functions before removing IconButton, which is the end anchor.
main = removeSection(
  main,
  "function getAvailableModels(",
  "function IconButton(",
  "model catalog helpers",
);
main = removeSection(main, "function IconButton(", "function AppTitlebar(", "IconButton");
main = removeSection(main, "function ModelChoice(", "function NewTaskModal(", "model controls");
main = removeSection(main, "function ModelMenu(", "function MarkdownCodeBlock(", "Composer");
main = removeSection(main, "function MarkdownCodeBlock(", "function SettingsPanel(", "Conversation and Route");
main = removeSection(main, "function SettingsPanel(", "function RenameTaskModal(", "SettingsPanel");

main = replaceOnce(
  main,
  `import {\n  AgentProcessTrace,\n  FoldableUserPrompt,\n  LiveAgentStatus,\n  RunDurationChip,\n} from "./conversation/RuntimeMessageUI";\nimport { serializeTaskCache } from "./state/task-store-core.js";`,
  `import { Composer } from "./composer/Composer.jsx";\nimport { Conversation, RouteView } from "./conversation/ConversationViews.jsx";\nimport { SettingsPanel } from "./settings/SettingsPanel.jsx";\nimport { IconButton, SegmentedControl, Switch } from "./components/Controls.jsx";\nimport {\n  getAvailableModels,\n  getDefaultTaskConfig,\n  getModel,\n} from "./models/model-catalog.js";\nimport { serializeTaskCache } from "./state/task-store-core.js";`,
  "renderer module imports",
);
main = main.replace(
  `import { useWorkspaceMentionAutocomplete } from "./composer/WorkspaceMentionAutocomplete.jsx";\n`,
  "",
);
main = main.replace(
  `import { TaskCapabilityCards } from "./settings/TaskCapabilityCards.jsx";\n`,
  "",
);
await writeFile("src/main.jsx", main, "utf8");

await rm("scripts/apply-v06-renderer-modules.mjs", { force: true });
await rm(".github/workflows/apply-v06-renderer-modules.yml", { force: true });
console.log("v0.6 renderer module extraction applied");

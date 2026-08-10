import { mkdir, readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

let main = await readFile("src/main.jsx", "utf8");
const startMarker = `  useEffect(() => {\n    if (!window.desktop?.harness?.onEvent) return undefined;`;
const endMarker = `  useEffect(() => {\n    if (!window.desktop?.notifications?.onTaskRequested) {`;
const start = main.indexOf(startMarker);
const end = main.indexOf(endMarker, start + startMarker.length);
if (start < 0 || end < 0) throw new Error("Harness event effect anchors not found");
const eventEffect = main.slice(start, end).trimEnd();

await mkdir("src/hooks", { recursive: true });
const hookModule = `import { useEffect } from "react";\nimport {\n  closeRunningRouteEntries,\n  getRouteToolMeta,\n  updateRunAssistant,\n} from "../p0-model";\n\n/**\n * Owns the renderer subscription to the Harness event protocol.\n *\n * This extraction deliberately preserves the existing event branches byte-for-byte\n * apart from their module boundary. Follow-up work can make the reducers pure and\n * test them independently without keeping protocol handling inside App.jsx.\n */\nexport function useHarnessEvents({\n  language,\n  tr,\n  runsRef,\n  setTasks,\n  setRunPaused,\n  setRunStatus,\n  setSandboxStatus,\n  setApproval,\n  normalizeWorkspacePath,\n}) {\n${eventEffect}\n}\n`;
await writeFile("src/hooks/useHarnessEvents.js", hookModule, "utf8");

main = `${main.slice(0, start)}  useHarnessEvents({\n    language,\n    tr,\n    runsRef,\n    setTasks,\n    setRunPaused,\n    setRunStatus,\n    setSandboxStatus,\n    setApproval,\n    normalizeWorkspacePath,\n  });\n\n${main.slice(end)}`;
main = replaceOnce(
  main,
  `import { useTaskStore } from "./state/useTaskStore.js";`,
  `import { useTaskStore } from "./state/useTaskStore.js";\nimport { useHarnessEvents } from "./hooks/useHarnessEvents.js";`,
  "Harness hook import",
);
await writeFile("src/main.jsx", main, "utf8");

await rm("scripts/apply-v06-harness-event-hook.mjs", { force: true });
await rm(".github/workflows/apply-v06-harness-event-hook.yml", { force: true });
console.log("v0.6 Harness event hook extraction applied");

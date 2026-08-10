import { readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  }
  return source.replace(before, after);
}

let main = await readFile("src/main.jsx", "utf8");
main = replaceOnce(
  main,
  `import { serializeTaskCache } from "./state/task-store-core.js";\nimport { useTaskStore } from "./state/useTaskStore.js";`,
  `import { serializeTaskCache } from "./state/task-store-core.js";\nimport { useTaskStore } from "./state/useTaskStore.js";\nimport { useWorkspaceMentionAutocomplete } from "./composer/WorkspaceMentionAutocomplete.jsx";\nimport { TaskCapabilityCards } from "./settings/TaskCapabilityCards.jsx";`,
  "native composer/settings imports",
);

main = replaceOnce(
  main,
  `  const model = getModel(\n    providers,\n    task.providerId,\n    task.modelId,\n  );\n\n  const send = () => {`,
  `  const model = getModel(\n    providers,\n    task.providerId,\n    task.modelId,\n  );\n  const mentionAutocomplete = useWorkspaceMentionAutocomplete({\n    value: message,\n    setValue: setMessage,\n    textareaRef,\n    workspacePath: task.workspacePath || "",\n  });\n\n  const send = () => {`,
  "workspace mention hook",
);

main = replaceOnce(
  main,
  `  const handleKeyDown = (event) => {\n    if (event.key === "Enter" && !event.shiftKey) {`,
  `  const handleKeyDown = (event) => {\n    if (mentionAutocomplete.handleKeyDown(event)) return;\n    if (event.key === "Enter" && !event.shiftKey) {`,
  "workspace mention keyboard routing",
);

main = replaceOnce(
  main,
  `        <textarea\n          ref={textareaRef}\n          value={message}\n          onChange={resizeTextarea}\n          onKeyDown={handleKeyDown}\n          onPaste={handlePaste}`, 
  `        {mentionAutocomplete.menu}\n        <textarea\n          ref={textareaRef}\n          value={message}\n          onChange={resizeTextarea}\n          onKeyDown={handleKeyDown}\n          onClick={mentionAutocomplete.refreshCursor}\n          onKeyUp={mentionAutocomplete.refreshCursor}\n          onPaste={handlePaste}`,
  "workspace mention menu render",
);

main = replaceOnce(
  main,
  `      <section className="settings-section">\n        <div className="settings-label">{tr("界面语言", "Interface language")}</div>`,
  `      <TaskCapabilityCards\n        task={task}\n        providers={providers}\n        onManageProviders={onManageProviders}\n      />\n\n      <section className="settings-section">\n        <div className="settings-label">{tr("界面语言", "Interface language")}</div>`,
  "native task capability cards",
);

main = replaceOnce(
  main,
  `    return window.desktop.harness.onEvent((event) => {\n      const run = runsRef.current.get(event.runId);\n      if (!run) return;\n\n      if (event.type === "control.paused") {`,
  `    return window.desktop.harness.onEvent((event) => {\n      const run = runsRef.current.get(event.runId);\n      if (!run) return;\n\n      if (event.type === "skill.activated") {\n        setTasks((current) =>\n          updateRunAssistant(current, run, (message) => ({\n            ...message,\n            activatedSkills: Array.isArray(event.skills) ? event.skills : [],\n            unresolvedSkills: Array.isArray(event.unresolved)\n              ? event.unresolved\n              : [],\n          })),\n        );\n        return;\n      }\n\n      if (event.type === "skill.unresolved") {\n        setTasks((current) =>\n          updateRunAssistant(current, run, (message) => ({\n            ...message,\n            unresolvedSkills: Array.isArray(event.unresolved)\n              ? event.unresolved\n              : [],\n          })),\n        );\n        return;\n      }\n\n      if (event.type === "control.paused") {`,
  "skill events into TaskStore message state",
);

await writeFile("src/main.jsx", main, "utf8");

let index = await readFile("index.html", "utf8");
index = index.replace(
  `    <link rel="stylesheet" href="/src/agent-process-mentions.css" />\n`,
  "",
);
index = index.replace(
  `    <script type="module" src="/src/runtime-ui-enhancements.jsx"></script>\n`,
  "",
);
index = index.replace(
  `    <script type="module" src="/src/live-agent-status.jsx"></script>\n`,
  "",
);
index = index.replace(
  `    <script type="module" src="/src/skill-status.jsx"></script>\n`,
  "",
);
index = index.replace(
  `    <script type="module" src="/src/prompt-folding.js"></script>\n`,
  "",
);
await writeFile("index.html", index, "utf8");

for (const path of [
  "src/runtime-ui-enhancements.jsx",
  "src/live-agent-status.jsx",
  "src/skill-status.jsx",
  "src/prompt-folding.js",
]) {
  await rm(path, { force: true });
}

await rm("scripts/apply-v06-native-composer-settings.mjs", { force: true });
await rm(".github/workflows/apply-v06-native-composer-settings.yml", { force: true });
console.log("v0.6 native Composer/Settings migration applied");

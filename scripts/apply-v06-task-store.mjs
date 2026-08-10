import { readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  }
  return source.replace(before, after);
}

function replaceSection(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`${label}: missing section anchor`);
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

let main = await readFile("src/main.jsx", "utf8");
main = replaceOnce(
  main,
  `} from "./conversation/RuntimeMessageUI";\nimport "./styles.css";`,
  `} from "./conversation/RuntimeMessageUI";\nimport { serializeTaskCache } from "./state/task-store-core.js";\nimport { useTaskStore } from "./state/useTaskStore.js";\nimport "./styles.css";`,
  "TaskStore imports",
);
main = replaceSection(
  main,
  `function createLightweightTaskCache(tasks) {`,
  `function getFolderName(folderPath) {`,
  `function cacheTasksLocally(tasks) {\n  try {\n    const snapshot = serializeTaskCache(tasks, {\n      maxTasks: Number.MAX_SAFE_INTEGER,\n    });\n    localStorage.setItem(STORAGE_KEY, snapshot.json);\n  } catch {\n    try {\n      const fallback = serializeTaskCache(tasks, {\n        maxBytes: 0,\n        maxTasks: 20,\n      });\n      localStorage.setItem(STORAGE_KEY, fallback.json);\n    } catch {\n      // Desktop persistence remains authoritative when browser quota is full.\n    }\n  }\n}\n\nfunction getFolderName(folderPath) {`,
  "local task cache helpers",
);
main = replaceOnce(
  main,
  `  const [tasks, setTasks] = useState(readSavedTasks);\n  const [activeTaskId, setActiveTaskId] = useState(\n    () => readSavedTasks()[0]?.id || null,\n  );`,
  `  const [tasks, setTasks] = useTaskStore(readSavedTasks);\n  const [activeTaskId, setActiveTaskId] = useState(\n    () => tasks[0]?.id || null,\n  );`,
  "App TaskStore state",
);
main = replaceOnce(
  main,
  `        let hydratedTasks =\n          storedTasks === null ||\n          (storedTasks.length === 0 && tasksRef.current.length > 0)\n            ? tasksRef.current\n            : storedTasks;\n        if (\n          storedTasks === null ||\n          (storedTasks.length === 0 && tasksRef.current.length > 0)\n        ) {\n          await window.desktop.tasks.save(tasksRef.current);\n        }`,
  `        // The desktop JSON store is the durable authority once it exists.\n        // Only a missing desktop file (null) may migrate the legacy startup\n        // cache. An intentional durable [] must never resurrect stale cached\n        // tasks.\n        let hydratedTasks =\n          storedTasks === null ? tasksRef.current : storedTasks;\n        if (storedTasks === null && tasksRef.current.length > 0) {\n          await window.desktop.tasks.save(tasksRef.current);\n        }`,
  "desktop task hydration authority",
);
await writeFile("src/main.jsx", main, "utf8");

await rm("scripts/apply-v06-task-store.mjs", { force: true });
await rm(".github/workflows/apply-v06-task-store.yml", { force: true });
console.log("v0.6 TaskStore integration applied");

import { readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`Missing migration anchor: ${label}`);
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Ambiguous migration anchor: ${label}`);
  }
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

let hook = await readFile("src/hooks/useHarnessEvents.js", "utf8");

hook = replaceOnce(
  hook,
  `  useEffect(() => {\n    if (!window.desktop?.harness?.onEvent) return undefined;\n    const toolLabels = {`,
  `  useEffect(() => {\n    if (!window.desktop?.harness?.onEvent) return undefined;\n\n    // Provider SSE can produce many tiny deltas per second. Updating the full\n    // TaskStore for every fragment creates renderer backpressure, especially in\n    // long conversations where Markdown and historical turns are also present.\n    // Buffer only presentation deltas for one short frame; the Provider stream\n    // itself remains unthrottled and the final Harness result is unchanged.\n    const STREAM_FLUSH_MS = 24;\n    const pendingDeltas = new Map();\n    let streamFlushTimer = null;\n\n    const flushPendingDeltas = () => {\n      if (!pendingDeltas.size) return;\n      const batch = [...pendingDeltas.entries()];\n      pendingDeltas.clear();\n      setTasks((current) => {\n        let next = current;\n        for (const [runId, delta] of batch) {\n          const bufferedRun = runsRef.current.get(runId);\n          if (!bufferedRun || !delta) continue;\n          next = updateRunAssistant(next, bufferedRun, (message) => ({\n            ...message,\n            content: \`\${message.content || ""}\${delta}\`,\n          }));\n        }\n        return next;\n      }, { type: "stream.delta.flush", batchSize: batch.length });\n    };\n\n    const scheduleDeltaFlush = () => {\n      if (streamFlushTimer !== null) return;\n      streamFlushTimer = window.setTimeout(() => {\n        streamFlushTimer = null;\n        flushPendingDeltas();\n      }, STREAM_FLUSH_MS);\n    };\n\n    const discardPendingDelta = (runId) => {\n      pendingDeltas.delete(runId);\n    };\n\n    const toolLabels = {`,
  "stream buffer setup",
);

hook = replaceOnce(
  hook,
  `    return window.desktop.harness.onEvent((event) => {`,
  `    const unsubscribe = window.desktop.harness.onEvent((event) => {`,
  "subscription assignment",
);

hook = replaceOnce(
  hook,
  `      if (event.type === "response.reset") {\n        setTasks((current) =>`,
  `      if (event.type === "response.reset") {\n        discardPendingDelta(event.runId);\n        setTasks((current) =>`,
  "response reset buffer discard",
);

hook = replaceOnce(
  hook,
  `      if (event.type === "response.delta") {\n        setTasks((current) =>\n          current.map((task) =>\n            task.id === run.taskId\n              ? {\n                  ...task,\n                  messages: task.messages.map((message) =>\n                    message.id === run.assistantId\n                      ? {\n                          ...message,\n                          content: \`\${message.content || ""}\${event.delta || ""}\`,\n                        }\n                      : message,\n                  ),\n                }\n              : task,\n          ),\n        );\n        return;\n      }`,
  `      if (event.type === "response.delta") {\n        const delta = String(event.delta || "");\n        if (delta) {\n          pendingDeltas.set(\n            event.runId,\n            \`\${pendingDeltas.get(event.runId) || ""}\${delta}\`,\n          );\n          scheduleDeltaFlush();\n        }\n        return;\n      }`,
  "response delta batching",
);

hook = replaceOnce(
  hook,
  `      if (event.type === "response.retry") {\n        setTasks((current) =>`,
  `      if (event.type === "response.retry") {\n        discardPendingDelta(event.runId);\n        setTasks((current) =>`,
  "response retry buffer discard",
);

hook = replaceOnce(
  hook,
  `      if (event.type === "turn.completed") {\n        const now = new Date().toISOString();`,
  `      if (event.type === "turn.completed") {\n        if (streamFlushTimer !== null) {\n          window.clearTimeout(streamFlushTimer);\n          streamFlushTimer = null;\n        }\n        flushPendingDeltas();\n        const now = new Date().toISOString();`,
  "turn completion flush",
);

hook = replaceOnce(
  hook,
  `      }\n    });\n  }, [language, tr]);\n}`,
  `      }\n    });\n\n    return () => {\n      if (streamFlushTimer !== null) {\n        window.clearTimeout(streamFlushTimer);\n        streamFlushTimer = null;\n      }\n      pendingDeltas.clear();\n      unsubscribe?.();\n    };\n  }, [language, tr]);\n}`,
  "subscription cleanup",
);

await writeFile("src/hooks/useHarnessEvents.js", hook, "utf8");

let main = await readFile("src/main.jsx", "utf8");
main = replaceOnce(
  main,
  `  useEffect(() => {\n    tasksRef.current = tasks;\n    cacheTasksLocally(tasks);\n  }, [tasks]);`,
  `  useEffect(() => {\n    tasksRef.current = tasks;\n  }, [tasks]);\n\n  useEffect(() => {\n    // localStorage is only a startup cache. Serializing the entire task history\n    // synchronously for every streamed token can block the renderer. Keep the\n    // cache reasonably fresh without putting it on the hot response.delta path.\n    const timeout = window.setTimeout(() => {\n      cacheTasksLocally(tasks);\n    }, 750);\n    return () => window.clearTimeout(timeout);\n  }, [tasks]);`,
  "debounced local task cache",
);
await writeFile("src/main.jsx", main, "utf8");

const packagePath = "package.json";
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
packageJson.scripts["test:streaming-performance"] =
  "node tests/streaming-performance-smoke.mjs";
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

await rm("scripts/apply-v06-streaming-performance.mjs", { force: true });
await rm(".github/workflows/apply-v06-streaming-performance.yml", { force: true });

console.log("streaming performance migration applied");

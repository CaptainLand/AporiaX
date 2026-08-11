import { readFile, writeFile, rm } from "node:fs/promises";

function once(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

let runtime = await readFile("electron/agent-runtime-core.js", "utf8");
runtime = once(
  runtime,
  `import { createSelfCheckCoordinator } from "./runtime/self-check-coordinator.js";\n`,
  `import { createSelfCheckCoordinator } from "./runtime/self-check-coordinator.js";\nimport { createTurnCoordinator } from "./runtime/turn-coordinator.js";\n`,
  "turn coordinator import",
);
runtime = once(
  runtime,
  `  const isEnglish = language === "en";\n`,
  `  const turnCoordinator = createTurnCoordinator({ runId, emit });\n  const isEnglish = language === "en";\n`,
  "turn coordinator creation",
);
runtime = once(
  runtime,
  `    for (let step = 0; ; step += 1) {\n      throwIfAborted(signal);\n      await applyRuntimeControlBoundary();`,
  `    for (let step = 0; ; step += 1) {\n      await turnCoordinator.beginRound({\n        signal,\n        applyControlBoundary: applyRuntimeControlBoundary,\n      });`,
  "round boundary",
);
runtime = once(
  runtime,
  `      if (\n        !Array.isArray(message.tool_calls) ||\n        message.tool_calls.length === 0\n      ) {`,
  `      const turnDecision = turnCoordinator.observeModelResponse(message);\n      if (turnDecision.kind === "final") {`,
  "model response classification",
);
runtime = once(
  runtime,
  `        if (\n          changes.length > 0 &&\n          !selfCheck.completed &&\n          progressiveEligible\n        ) {`,
  `        if (\n          changes.length > 0 &&\n          !selfCheck.completed &&\n          progressiveEligible\n        ) {\n          turnCoordinator.beginReview({ reason: "progressive-self-check" });`,
  "review lifecycle",
);
runtime = once(
  runtime,
  `        completedResult.content = finalContent;\n        emit({\n          type: "turn.completed",`,
  `        completedResult.content = finalContent;\n        turnCoordinator.complete({\n          changedFiles: completedResult.changes.length,\n          toolSteps: steps.length,\n        });\n        emit({\n          type: "turn.completed",`,
  "completed lifecycle",
);
runtime = once(
  runtime,
  `      if (mainToolBatchCanRunInParallel(message.tool_calls)) {\n        emit({`,
  `      if (mainToolBatchCanRunInParallel(message.tool_calls)) {\n        turnCoordinator.beginToolBatch(message.tool_calls, { parallel: true });\n        emit({`,
  "parallel tool lifecycle",
);
runtime = once(
  runtime,
  `      for (const toolCall of message.tool_calls) {\n`,
  `      turnCoordinator.beginToolBatch(message.tool_calls, { parallel: false });\n      for (const toolCall of message.tool_calls) {\n`,
  "serial tool lifecycle",
);
runtime = once(
  runtime,
  `      emit({\n        type: "turn.cancelled",`,
  `      turnCoordinator.interrupt({\n        changedFiles: interruptedResult.changes.length,\n        toolSteps: steps.length,\n      });\n      emit({\n        type: "turn.cancelled",`,
  "interrupted lifecycle",
);
runtime = once(
  runtime,
  `    emit({\n      type: "turn.failed",`,
  `    turnCoordinator.fail(error);\n    emit({\n      type: "turn.failed",`,
  "failed lifecycle",
);
await writeFile("electron/agent-runtime-core.js", runtime, "utf8");

let pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:turn-coordinator"] = "node tests/turn-coordinator-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-turn-coordinator.mjs", { force: true });
await rm(".github/workflows/validate-turn-coordinator.yml", { force: true });
console.log("turn coordinator integration applied");

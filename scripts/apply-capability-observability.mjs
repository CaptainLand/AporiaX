import { readFile, writeFile, rm } from "node:fs/promises";

function once(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

let runtime = await readFile("electron/agent-runtime-core.js", "utf8");
runtime = once(
  runtime,
  `      describeToolActivity,\n    })`,
  `      describeToolActivity,\n      describeCapability: (toolName, phase = "work") =>\n        capabilityRegistry?.describeTool(toolName, phase) || null,\n    })`,
  "subagent capability resolver",
);
runtime = once(
  runtime,
  `            const toolName = toolCall.function.name;\n            const activity = describeToolActivity(toolCall);`,
  `            const toolName = toolCall.function.name;\n            const phase = selfCheck.started ? "self-check" : "work";\n            const capability = capabilityRegistry?.describeTool(toolName, phase) || null;\n            const activity = describeToolActivity(toolCall);`,
  "parallel capability",
);
runtime = runtime.replaceAll(
  `              phase: selfCheck.started ? "self-check" : "work",\n              parallel: true,`,
  `              phase,\n              capability,\n              parallel: true,`,
);
runtime = runtime.replaceAll(
  `              phase: selfCheck.started ? "self-check" : "work",\n              planStepId:`,
  `              phase,\n              capability,\n              planStepId:`,
);
runtime = once(
  runtime,
  `        const activity = describeToolActivity(toolCall);\n        emit({\n          type: "tool.requested",`,
  `        const phase = selfCheck.started ? "self-check" : "work";\n        const capability = capabilityRegistry?.describeTool(toolCall.function.name, phase) || null;\n        const activity = describeToolActivity(toolCall);\n        emit({\n          type: "tool.requested",`,
  "serial capability",
);
runtime = runtime.replaceAll(
  `          phase: selfCheck.started ? "self-check" : "work",\n        });\n        emit({\n          type: "tool.started",`,
  `          phase,\n          capability,\n        });\n        emit({\n          type: "tool.started",`,
);
runtime = runtime.replaceAll(
  `          phase: selfCheck.started ? "self-check" : "work",\n          planStepId:`,
  `          phase,\n          capability,\n          planStepId:`,
);
// Completion events should retain the same capability snapshot even when a
// dynamic MCP scope is torn down immediately after the turn.
runtime = runtime.replaceAll(
  `              phase: selfCheck.started ? "self-check" : "work",\n              parallel: true,`,
  `              phase,\n              capability,\n              parallel: true,`,
);
runtime = runtime.replaceAll(
  `          phase: selfCheck.started ? "self-check" : "work",\n        });`,
  `          phase,\n          capability,\n        });`,
);
await writeFile("electron/agent-runtime-core.js", runtime, "utf8");

let subagent = await readFile("electron/runtime/subagent-loop.js", "utf8");
subagent = once(
  subagent,
  `  executeAuthorizedTool,\n  describeToolActivity,\n}) {`,
  `  executeAuthorizedTool,\n  describeToolActivity,\n  describeCapability,\n}) {`,
  "subagent resolver parameter",
);
subagent = once(
  subagent,
  `  const activityFor =\n    typeof describeToolActivity === "function"\n      ? describeToolActivity\n      : () => ({});`,
  `  const activityFor =\n    typeof describeToolActivity === "function"\n      ? describeToolActivity\n      : () => ({});\n  const capabilityFor =\n    typeof describeCapability === "function"\n      ? describeCapability\n      : () => null;`,
  "subagent capability helper",
);
subagent = once(
  subagent,
  `        const toolName = toolCall.function.name;\n        let modelResult;`,
  `        const toolName = toolCall.function.name;\n        const capabilityPhase = ["review", "verify"].includes(input.role)\n          ? "self-check"\n          : "work";\n        const capability = capabilityFor(toolName, capabilityPhase);\n        let modelResult;`,
  "subagent tool capability",
);
subagent = once(
  subagent,
  `          tool: toolName,\n          parallel: parallelBatch,\n          ...activityFor(toolCall),`,
  `          tool: toolName,\n          capability,\n          parallel: parallelBatch,\n          ...activityFor(toolCall),`,
  "subagent started capability",
);
subagent = subagent.replace(
  `          tool: toolName,\n          success,`,
  `          tool: toolName,\n          capability,\n          success,`,
);
await writeFile("electron/runtime/subagent-loop.js", subagent, "utf8");

let witness = await readFile("electron/witness-monitor.js", "utf8");
witness = once(
  witness,
  `    tool: record.tool || null,\n    status: record.status,`,
  `    tool: record.tool || null,\n    phase: record.phase || null,\n    capability: record.capability || null,\n    status: record.status,`,
  "public witness capability",
);
witness = once(
  witness,
  `      tool: input.tool || null,\n      status: input.status || "completed",`,
  `      tool: input.tool || null,\n      phase: input.phase || null,\n      capability: input.capability || null,\n      status: input.status || "completed",`,
  "witness record capability",
);
witness = once(
  witness,
  `    record.command = clipped(event?.command, 700) || record.command;\n    return record;`,
  `    record.command = clipped(event?.command, 700) || record.command;\n    record.phase = event?.phase || record.phase || null;\n    record.capability = event?.capability || record.capability || null;\n    return record;`,
  "witness completion capability",
);
witness = witness.replaceAll(
  `          tool: event.tool,\n          status: "running",`,
  `          tool: event.tool,\n          phase: event.phase || null,\n          capability: event.capability || null,\n          status: "running",`,
);
await writeFile("electron/witness-monitor.js", witness, "utf8");

let p0 = await readFile("src/p0-model.js", "utf8");
p0 = once(
  p0,
  `export function getRouteToolMeta(tool, phase, language = "zh-CN") {\n  const meta = ROUTE_TOOL_META[tool] || {`,
  `export function getRouteToolMeta(tool, phase, language = "zh-CN", capability = null) {\n  if (capability?.stage) {\n    return {\n      stage: capability.stage,\n      zh: capability.titleZh || capability.title || tool || "执行工具",\n      en: capability.titleEn || capability.title || tool || "Run tool",\n      title:\n        language === "en"\n          ? capability.titleEn || capability.title || tool || "Run tool"\n          : capability.titleZh || capability.title || tool || "执行工具",\n      activity:\n        language === "en"\n          ? capability.activityEn || capability.titleEn || capability.title || tool\n          : capability.activityZh || capability.titleZh || capability.title || tool,\n      iconKey: capability.iconKey || null,\n      source: capability.source || null,\n      risk: capability.risk || null,\n      capabilityId: capability.id || null,\n    };\n  }\n  const meta = ROUTE_TOOL_META[tool] || {`,
  "p0 capability metadata",
);
p0 = once(
  p0,
  `    const stage = getRouteToolMeta(record.tool, record.phase).stage;`,
  `    const stage = getRouteToolMeta(record.tool, record.phase, "zh-CN", record.capability).stage;`,
  "witness capability stage",
);
await writeFile("src/p0-model.js", p0, "utf8");

let hook = await readFile("src/hooks/useHarnessEvents.js", "utf8");
// Keep the fallback map only for old history/events. New events consume the
// capability snapshot emitted by the runtime.
hook = once(
  hook,
  `      if (event.type === "subagent.tool.started") {\n        const meta = getRouteToolMeta(event.tool, "work", language);`,
  `      if (event.type === "subagent.tool.started") {\n        const meta = getRouteToolMeta(\n          event.tool,\n          ["review", "verify"].includes(event.role) ? "self-check" : "work",\n          language,\n          event.capability,\n        );`,
  "subagent route capability",
);
hook = once(
  hook,
  `                tool: event.tool,\n                path: event.path || "",`,
  `                tool: event.tool,\n                capability: event.capability || null,\n                path: event.path || "",`,
  "subagent route record capability",
);
hook = once(
  hook,
  `            toolLabels[event.tool] ||\n            event.tool,`,
  `            meta.activity ||\n            toolLabels[event.tool] ||\n            event.tool,`,
  "subagent activity metadata",
);
hook = once(
  hook,
  `      if (event.type === "tool.started") {\n        const meta = getRouteToolMeta(event.tool, event.phase, language);`,
  `      if (event.type === "tool.started") {\n        const meta = getRouteToolMeta(\n          event.tool,\n          event.phase,\n          language,\n          event.capability,\n        );`,
  "main route capability",
);
hook = once(
  hook,
  `                  tool: event.tool,\n                  phase: event.phase,`,
  `                  tool: event.tool,\n                  capability: event.capability || null,\n                  phase: event.phase,`,
  "main route record capability",
);
hook = once(
  hook,
  `          title:\n            toolLabels[event.tool] ||\n            (String(event.tool || "").startsWith("mcp__") ||\n            String(event.tool || "").startsWith("mcp_")\n              ? tr("正在调用 MCP 能力", "Calling MCP capability")\n              : tr("Harness 正在运行", "Harness is running")),`,
  `          title:\n            meta.activity ||\n            toolLabels[event.tool] ||\n            tr("Harness 正在运行", "Harness is running"),`,
  "main activity metadata",
);
await writeFile("src/hooks/useHarnessEvents.js", hook, "utf8");

await rm("scripts/apply-capability-observability.mjs", { force: true });
await rm(".github/workflows/validate-capability-observability.yml", { force: true });
console.log("capability observability migration applied");

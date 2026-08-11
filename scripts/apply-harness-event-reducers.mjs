import { readFile, writeFile, rm } from "node:fs/promises";

function once(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

function replaceRange(source, start, end, replacement, label) {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) throw new Error(`${label}: start anchor missing`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`${label}: end anchor missing`);
  return source.slice(0, startIndex) + replacement + source.slice(endIndex);
}

let hook = await readFile("src/hooks/useHarnessEvents.js", "utf8");
hook = once(
  hook,
  `} from "../p0-model";\n`,
  `} from "../p0-model";\nimport {\n  PURE_TASK_EVENT_TYPES,\n  reduceHarnessTaskEvent,\n} from "../state/harness-event-reducer.js";\n`,
  "reducer import",
);
hook = once(
  hook,
  `      const run = runsRef.current.get(event.runId);\n      if (!run) return;\n`,
  `      const run = runsRef.current.get(event.runId);\n      if (!run) return;\n      const reduceTaskEvent = (targetEvent = event) => {\n        if (!PURE_TASK_EVENT_TYPES.has(targetEvent.type)) return;\n        setTasks((current) =>\n          reduceHarnessTaskEvent(current, run, targetEvent, { language, tr }),\n        );\n      };\n`,
  "reducer dispatcher",
);

hook = replaceRange(
  hook,
  `      if (event.type === "skill.activated") {`,
  `      if (event.type === "skill.unresolved") {`,
  `      if (event.type === "skill.activated") {\n        reduceTaskEvent();\n        return;\n      }\n\n`,
  "skill activated",
);
hook = replaceRange(
  hook,
  `      if (event.type === "skill.unresolved") {`,
  `      if (event.type === "control.paused") {`,
  `      if (event.type === "skill.unresolved") {\n        reduceTaskEvent();\n        return;\n      }\n\n`,
  "skill unresolved",
);

const planStart = `      if (event.type === "plan.updated") {`;
const planActive = `        const activeStep = event.plan?.steps?.find(`;
const planIndex = hook.indexOf(planStart);
const activeIndex = hook.indexOf(planActive, planIndex);
if (planIndex < 0 || activeIndex < 0) throw new Error("plan reducer anchors missing");
const planPrefixEnd = planIndex + planStart.length;
hook = hook.slice(0, planPrefixEnd) + `\n        reduceTaskEvent();\n` + hook.slice(activeIndex);

hook = replaceRange(
  hook,
  `      if (event.type === "witness.updated") {`,
  `      if (event.type === "response.reset") {`,
  `      if (event.type === "witness.updated") {\n        reduceTaskEvent();\n        return;\n      }\n\n`,
  "witness updated",
);

const resetStart = `      if (event.type === "response.reset") {\n        discardPendingDelta(event.runId);`;
const resetStatus = `        setRunStatus({`;
const resetIndex = hook.indexOf(resetStart);
const resetStatusIndex = hook.indexOf(resetStatus, resetIndex);
if (resetIndex < 0 || resetStatusIndex < 0) throw new Error("response reset anchors missing");
const resetPrefixEnd = resetIndex + resetStart.length;
hook = hook.slice(0, resetPrefixEnd) + `\n        reduceTaskEvent();\n` + hook.slice(resetStatusIndex);

const subStart = `      if (event.type === "subagent.tool.started") {`;
const subStatus = `        setRunStatus({`;
const subIndex = hook.indexOf(subStart);
const subStatusIndex = hook.indexOf(subStatus, subIndex);
if (subIndex < 0 || subStatusIndex < 0) throw new Error("subagent started anchors missing");
const subMeta = `      if (event.type === "subagent.tool.started") {\n        const meta = getRouteToolMeta(\n          event.tool,\n          ["review", "verify"].includes(event.role) ? "self-check" : "work",\n          language,\n          event.capability,\n        );\n        reduceTaskEvent();\n`;
hook = hook.slice(0, subIndex) + subMeta + hook.slice(subStatusIndex);

hook = replaceRange(
  hook,
  `      if (event.type === "subagent.tool.completed") {`,
  `      if (\n        event.type === "subagent.completed" ||`,
  `      if (event.type === "subagent.tool.completed") {\n        reduceTaskEvent();\n        return;\n      }\n\n`,
  "subagent completed",
);

const toolStart = `      if (event.type === "tool.started") {`;
const toolStatus = `        setRunStatus({`;
const toolIndex = hook.indexOf(toolStart);
const toolStatusIndex = hook.indexOf(toolStatus, toolIndex);
if (toolIndex < 0 || toolStatusIndex < 0) throw new Error("tool started anchors missing");
const toolMeta = `      if (event.type === "tool.started") {\n        const meta = getRouteToolMeta(\n          event.tool,\n          event.phase,\n          language,\n          event.capability,\n        );\n        reduceTaskEvent();\n`;
hook = hook.slice(0, toolIndex) + toolMeta + hook.slice(toolStatusIndex);

const completedStart = `      if (event.type === "tool.completed") {`;
const completedStatus = `        setRunStatus({`;
const completedIndex = hook.indexOf(completedStart);
const completedStatusIndex = hook.indexOf(completedStatus, completedIndex);
if (completedIndex < 0 || completedStatusIndex < 0) throw new Error("tool completed anchors missing");
hook = hook.slice(0, completedIndex) + `      if (event.type === "tool.completed") {\n        reduceTaskEvent();\n` + hook.slice(completedStatusIndex);

hook = replaceRange(
  hook,
  `      if (event.type === "file.changed") {`,
  `      if (event.type === "self_check.segment.started") {`,
  `      if (event.type === "file.changed") {\n        reduceTaskEvent();\n        return;\n      }\n\n`,
  "file changed",
);

await writeFile("src/hooks/useHarnessEvents.js", hook, "utf8");

let pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:harness-event-reducer"] = "node tests/harness-event-reducer-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-harness-event-reducers.mjs", { force: true });
await rm(".github/workflows/validate-harness-event-reducers.yml", { force: true });
console.log("Harness event reducer migration applied");

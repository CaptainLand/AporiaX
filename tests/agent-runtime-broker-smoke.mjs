import assert from "node:assert/strict";
import { createHarnessKernel } from "../electron/harness/kernel.js";

const emitted = [];
const kernel = createHarnessKernel({ schedulerConcurrency: 2 });
const result = await kernel.agentRuntime.run({
  agentId: "run-1-sub-1",
  role: "explore",
  task: "Inspect the repository structure.",
  parentRunId: "run-1",
  taskId: "task-1",
  emit: (event) => emitted.push(event),
  execute: async ({ definition }) => {
    assert.equal(definition.name, "explore");
    assert(definition.tools.includes("read_file"));
    return {
      status: "completed",
      summary: "Repository structure inspected.",
      rounds: 1,
    };
  },
});

assert.equal(result.status, "completed");
assert.equal(kernel.sessions.get("run-1-sub-1").state, "completed");
assert(
  emitted.some((event) => event.type === "agent.runtime.queued"),
);
assert(
  emitted.some((event) => event.type === "agent.runtime.started"),
);
assert(
  emitted.some((event) => event.type === "agent.runtime.completed"),
);
assert.equal(kernel.capabilities().unifiedAgentRuntime, true);
assert(kernel.agents.get("main"));

console.log("agent runtime broker smoke: PASS");

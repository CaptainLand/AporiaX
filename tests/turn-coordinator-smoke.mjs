import assert from "node:assert/strict";
import { createTurnCoordinator } from "../electron/runtime/turn-coordinator.js";

const events = [];
let boundaries = 0;
const coordinator = createTurnCoordinator({
  runId: "run-1",
  emit: (event) => events.push(event),
});

assert.equal(coordinator.snapshot().phase, "preparing");
const first = await coordinator.beginRound({
  applyControlBoundary: async () => {
    boundaries += 1;
  },
});
assert.equal(first.round, 1);
assert.equal(first.phase, "model");
assert.equal(boundaries, 1);

let decision = coordinator.observeModelResponse({
  tool_calls: [{ id: "1" }, { id: "2" }],
});
assert.equal(decision.kind, "tools");
assert.equal(decision.toolCalls.length, 2);
coordinator.beginToolBatch(decision.toolCalls, { parallel: true });
assert.equal(coordinator.snapshot().toolBatches, 1);
assert.equal(coordinator.snapshot().toolCalls, 2);

coordinator.requestContinuation("tools-complete");
assert.equal(coordinator.snapshot().phase, "preparing");
await coordinator.beginRound({ applyControlBoundary: async () => {} });
assert.equal(coordinator.snapshot().round, 2);
decision = coordinator.observeModelResponse({ content: "done" });
assert.equal(decision.kind, "final");
assert.equal(coordinator.snapshot().phase, "finalizing");
coordinator.beginReview({ reason: "final-seal" });
assert.equal(coordinator.snapshot().phase, "review");
coordinator.complete({ changedFiles: 2 });
assert.equal(coordinator.snapshot().phase, "completed");
assert.equal(coordinator.snapshot().terminal, true);
assert.throws(() => coordinator.transition("model"), /terminal/i);

assert(events.some((event) => event.type === "turn.phase.changed" && event.phase === "model"));
assert(events.some((event) => event.type === "turn.continuation.requested"));
assert(events.some((event) => event.type === "turn.phase.changed" && event.phase === "completed"));

const interrupted = createTurnCoordinator({ runId: "run-2" });
interrupted.interrupt();
assert.equal(interrupted.snapshot().phase, "interrupted");

const failed = createTurnCoordinator({ runId: "run-3" });
failed.fail(new Error("boom"));
assert.equal(failed.snapshot().phase, "failed");

const controller = new AbortController();
controller.abort();
const aborted = createTurnCoordinator({ runId: "run-4" });
await assert.rejects(
  () => aborted.beginRound({ signal: controller.signal }),
  (error) => error?.name === "AbortError",
);

console.log("turn coordinator smoke: PASS");

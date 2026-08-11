import assert from "node:assert/strict";
import { createWitnessMonitor } from "../electron/witness-monitor.js";

let clock = Date.parse("2026-08-11T00:00:00.000Z");
const emitted = [];
const witness = createWitnessMonitor({
  emit: (event) => emitted.push(event),
  now: () => clock,
  heartbeatMs: 0,
});

witness.observe({ type: "turn.started" });
witness.observe({
  type: "tool.started",
  callId: "slow-1",
  tool: "run_command",
  command: "npm test",
});
clock += 45_000;
witness.observe({
  type: "witness.command.slow",
  command: "npm test",
  elapsedMs: 45_000,
  advice: "Narrow the verification target.",
});
clock += 75_000;
witness.observe({
  type: "witness.command.intervention",
  command: "npm test",
  elapsedMs: 120_000,
  advice: "Command stopped; choose a bounded strategy.",
});

const snapshot = witness.snapshot();
assert(snapshot.alerts.some((alert) => alert.code.startsWith("slow-command:")));
assert(snapshot.alerts.some((alert) => alert.code.startsWith("command-intervention:")));
assert(snapshot.records.some((record) => record.actor === "witness" && record.kind === "warning"));
assert(emitted.some((event) => event.type === "witness.updated"));
witness.dispose();

console.log("witness watchdog smoke: PASS");

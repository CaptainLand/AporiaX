import assert from "node:assert/strict";
import { createSelfCheckCoordinator } from "../electron/runtime/self-check-coordinator.js";

function createState() {
  return {
    started: false,
    completed: false,
    mode: "progressive",
    reviewedVersions: new Map(),
    report: null,
    seal: null,
    segments: [],
    segmentCounter: 0,
    legacyFallback: false,
    repeatedBlockedAttempts: 0,
    lastBlockedSignature: "",
    verificationCandidates: [],
    verificationAttempted: false,
    verificationPassed: false,
    verificationResults: [],
  };
}

const changeMap = new Map([
  [
    "src/a.js",
    {
      path: "src/a.js",
      beforeContent: "const a = 1;\n",
      afterContent: "const a = 2;\n",
      beforeMissing: false,
      afterMissing: false,
      binary: false,
    },
  ],
]);
const selfCheck = createState();
const events = [];
let subagentCalls = 0;
const coordinator = createSelfCheckCoordinator({
  selfCheck,
  changeMap,
  language: "en",
  emit: (event) => events.push(event),
  startSubagent: async (input, agentId) => {
    subagentCalls += 1;
    assert.equal(input.role, "review");
    assert.deepEqual(input.scope, ["src/a.js"]);
    return {
      agentId,
      status: "completed",
      summary: JSON.stringify({
        verdict: "pass",
        checks: ["read latest file"],
        findings: [],
        remaining_risks: [],
      }),
      evidence: [
        {
          tool: "read_file",
          path: "src/a.js",
          preview: "const a = 2;",
        },
      ],
    };
  },
  commandToolAvailable: false,
  discoverVerificationCommands: async () => [],
  workspaceRoot: "/workspace",
});

const segment = await coordinator.runSegment({
  reason: "final-seal",
  runVerification: false,
});
assert.equal(subagentCalls, 1);
assert.equal(segment.verdict, "pass");
assert.equal(selfCheck.reviewedVersions.get("src/a.js"), "const a = 2;\n");
assert(events.some((event) => event.type === "self_check.segment.started"));
assert(events.some((event) => event.type === "self_check.segment.completed"));

const seal = await coordinator.seal();
assert(seal?.id?.startsWith("seal-"));
assert.equal(selfCheck.completed, true);
assert.equal(selfCheck.mode, "progressive");
assert.deepEqual(seal.reviewedFiles, ["src/a.js"]);
assert.match(selfCheck.report.summary, /final evidence seal/i);
assert(
  selfCheck.report.remainingRisks.some((risk) =>
    /verification|验证脚本/i.test(risk),
  ),
);
assert(events.some((event) => event.type === "self_check.sealed"));
assert(events.some((event) => event.type === "self_check.completed"));

const staleState = createState();
const staleChanges = new Map([
  [
    "src/b.js",
    {
      path: "src/b.js",
      beforeContent: "one",
      afterContent: "two",
      beforeMissing: false,
      afterMissing: false,
      binary: false,
    },
  ],
]);
let releaseReview;
const pendingReview = new Promise((resolve) => {
  releaseReview = resolve;
});
const staleCoordinator = createSelfCheckCoordinator({
  selfCheck: staleState,
  changeMap: staleChanges,
  language: "en",
  emit: () => {},
  startSubagent: async (_input, agentId) => {
    await pendingReview;
    return {
      agentId,
      status: "completed",
      summary: JSON.stringify({
        verdict: "needs_changes",
        checks: ["reviewed"],
        findings: [
          { severity: "medium", path: "src/b.js", message: "fix this" },
        ],
        remaining_risks: [],
      }),
      evidence: [{ tool: "read_file", path: "src/b.js", preview: "two" }],
    };
  },
  commandToolAvailable: false,
  discoverVerificationCommands: async () => [],
  workspaceRoot: "/workspace",
});
const scheduled = staleCoordinator.scheduleSegment({
  reason: "change-batch",
  runVerification: false,
});
assert.equal(scheduled.scheduled, true);
assert.equal(await staleCoordinator.consumeReviewJob(), "");
staleChanges.get("src/b.js").afterContent = "three";
releaseReview();
assert.equal(await staleCoordinator.consumeReviewJob({ wait: true }), "");

console.log("self-check coordinator smoke: PASS");

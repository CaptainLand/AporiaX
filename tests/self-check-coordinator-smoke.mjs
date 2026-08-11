import assert from "node:assert/strict";
import { createSelfCheckCoordinator } from "../electron/runtime/self-check-coordinator.js";
import {
  buildSelfCheckResult,
  evaluateAdaptiveSelfCheck,
} from "../electron/runtime/self-check-evidence.js";

assert.deepEqual(
  evaluateAdaptiveSelfCheck({ changes: [], prompt: "hello" }),
  { required: false, reasons: [], source: "skipped" },
  "casual conversation should not start self-check",
);
assert.equal(
  evaluateAdaptiveSelfCheck({
    requested: true,
    requestReason: "The implementation relies on an uncertain edge case.",
    changes: [
      {
        path: "src/a.js",
        beforeContent: "a",
        afterContent: "b",
      },
    ],
  }).source,
  "model",
  "the model can explicitly request adaptive review",
);
assert.equal(
  evaluateAdaptiveSelfCheck({
    changes: [
      { path: "a.js", beforeContent: "a", afterContent: "b" },
      { path: "b.js", beforeContent: "a", afterContent: "b" },
      { path: "c.js", beforeContent: "a", afterContent: "b" },
    ],
  }).required,
  true,
  "Harness keeps a multi-file safety fallback",
);
const optionalChangeMap = new Map([
  [
    "note.txt",
    {
      path: "note.txt",
      beforeContent: "old",
      afterContent: "new",
      beforeMissing: false,
      afterMissing: false,
      binary: false,
    },
  ],
]);
assert.deepEqual(
  buildSelfCheckResult(
    {
      required: false,
      mode: "adaptive",
      decisionSource: "skipped",
      decisionReason: "No material risk.",
      reviewedVersions: new Map(),
      verificationCandidates: [],
      verificationResults: [],
    },
    optionalChangeMap,
  ),
  {
    required: false,
    completed: true,
    reviewedFiles: [],
    summary: "No material risk.",
    checks: [],
    improvements: [],
    remainingRisks: [],
    verification: {
      required: false,
      attempted: false,
      passed: false,
      candidates: [],
      results: [],
    },
    mode: "adaptive",
    decision: "skipped",
    segments: [],
    seal: null,
  },
);

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

const failedReadState = createState();
const failedReadChanges = new Map([
  [
    "src/unreadable.js",
    {
      path: "src/unreadable.js",
      beforeContent: "before",
      afterContent: "after",
      beforeMissing: false,
      afterMissing: false,
      binary: false,
    },
  ],
]);
const failedReadCoordinator = createSelfCheckCoordinator({
  selfCheck: failedReadState,
  changeMap: failedReadChanges,
  language: "en",
  emit: () => {},
  startSubagent: async (_input, agentId) => ({
    agentId,
    status: "completed",
    summary: JSON.stringify({
      verdict: "pass",
      checks: ["attempted to read latest file"],
      findings: [],
      remaining_risks: [],
    }),
    evidence: [
      {
        tool: "read_file",
        path: "src/unreadable.js",
        error: "ENOENT: file could not be read",
      },
    ],
  }),
  commandToolAvailable: false,
  discoverVerificationCommands: async () => [],
  workspaceRoot: "/workspace",
});
const failedReadSegment = await failedReadCoordinator.runSegment({
  reason: "failed-read-evidence",
  runVerification: false,
});
assert.equal(failedReadSegment.verdict, "uncertain");
assert.equal(failedReadState.reviewedVersions.has("src/unreadable.js"), false);
assert(
  failedReadSegment.remainingRisks.some((risk) =>
    /missing file read evidence|缺少文件读取证据/i.test(risk),
  ),
);

const failedVerificationState = createState();
failedVerificationState.verificationCandidates = [
  { command: "npm test", cwd: "." },
  { command: "npm run lint", cwd: "." },
];
const failedVerificationChanges = new Map([
  [
    "src/verified.js",
    {
      path: "src/verified.js",
      beforeContent: "before",
      afterContent: "after",
      beforeMissing: false,
      afterMissing: false,
      binary: false,
    },
  ],
]);
const failedVerificationCoordinator = createSelfCheckCoordinator({
  selfCheck: failedVerificationState,
  changeMap: failedVerificationChanges,
  language: "en",
  emit: () => {},
  startSubagent: async (input, agentId) =>
    input.role === "review"
      ? {
          agentId,
          status: "completed",
          summary: JSON.stringify({
            verdict: "pass",
            checks: ["read latest file"],
            findings: [],
            remaining_risks: [],
          }),
          evidence: [
            { tool: "read_file", path: "src/verified.js", preview: "after" },
          ],
        }
      : {
          agentId,
          status: "completed",
          summary: JSON.stringify({
            verdict: "fail",
            commands: [
              {
                command: "npm test",
                cwd: ".",
                exit_code: 0,
                passed: true,
              },
              {
                command: "npm run lint",
                cwd: ".",
                exit_code: 1,
                passed: false,
              },
            ],
            checks: ["test command failed"],
            remaining_risks: [],
          }),
          evidence: [
            {
              tool: "run_command",
              command: "npm test",
              cwd: ".",
              exitCode: 0,
              error: null,
            },
            {
              tool: "run_command",
              command: "npm run lint",
              cwd: ".",
              exitCode: 1,
              error: "tests failed",
            },
          ],
        },
  commandToolAvailable: true,
  discoverVerificationCommands: async () =>
    failedVerificationState.verificationCandidates,
  workspaceRoot: "/workspace",
});
const failedVerificationSegment =
  await failedVerificationCoordinator.runSegment({
    reason: "failed-verification",
    runVerification: true,
  });
assert.equal(failedVerificationSegment.verdict, "needs_changes");
assert.equal(failedVerificationState.verificationAttempted, true);
assert.equal(failedVerificationState.verificationPassed, false);
assert(
  failedVerificationSegment.remainingRisks.some((risk) =>
    /verification command failed|验证命令未通过/i.test(risk),
  ),
);

console.log("self-check coordinator smoke: PASS");

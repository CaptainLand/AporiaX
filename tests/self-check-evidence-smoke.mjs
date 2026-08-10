import assert from "node:assert/strict";
import {
  buildChanges,
  buildSelfCheckResult,
  createChangeVersionSignature,
  createProgressiveReviewTask,
  createProgressiveVerifyTask,
  createSelfCheckPrompt,
  findVerificationCandidate,
  getPendingSelfCheckPaths,
  normalizeSelfCheckReport,
  parseProgressiveReviewReport,
  reviewableChanges,
} from "../electron/runtime/self-check-evidence.js";

const changes = new Map([
  [
    "src/a.js",
    {
      path: "src/a.js",
      beforeContent: "a\n",
      afterContent: "b\n",
      beforeMissing: false,
      afterMissing: false,
      binary: false,
    },
  ],
  [
    "unchanged.js",
    {
      path: "unchanged.js",
      beforeContent: "same",
      afterContent: "same",
      beforeMissing: false,
      afterMissing: false,
      binary: false,
    },
  ],
]);
assert.deepEqual(buildChanges(changes).map((change) => change.path), ["src/a.js"]);
assert.deepEqual(reviewableChanges(changes).map((change) => change.path), ["src/a.js"]);
assert.deepEqual(getPendingSelfCheckPaths(changes), ["src/a.js"]);
assert.deepEqual(
  getPendingSelfCheckPaths(changes, new Map([["src/a.js", "b\n"]])),
  [],
);
assert.equal(createChangeVersionSignature(buildChanges(changes)).length, 64);

assert.deepEqual(
  normalizeSelfCheckReport({
    summary: "reviewed",
    checks: ["syntax"],
    improvements: [],
    remaining_risks: ["manual UI check"],
  }),
  {
    summary: "reviewed",
    checks: ["syntax"],
    improvements: [],
    remainingRisks: ["manual UI check"],
  },
);
assert.throws(
  () =>
    normalizeSelfCheckReport({
      summary: "reviewed",
      checks: [],
      improvements: [],
      remaining_risks: [],
    }),
  /at least one concrete check/i,
);

const review = parseProgressiveReviewReport(
  '{"verdict":"pass","checks":["read file"],"findings":[],"remaining_risks":[]}',
  "review",
);
assert.equal(review.verdict, "pass");
assert.equal(review.parseError, false);
const invalid = parseProgressiveReviewReport("not json", "review");
assert.equal(invalid.verdict, "uncertain");
assert.equal(invalid.parseError, true);

assert.match(
  createProgressiveReviewTask(buildChanges(changes), "final-seal", "en"),
  /src\/a\.js/,
);
assert.match(
  createProgressiveVerifyTask(
    [{ command: "npm test", cwd: "." }],
    "final-seal",
    "zh-CN",
  ),
  /npm test/,
);
assert.match(
  createSelfCheckPrompt(
    changes,
    [{ command: "npm test", cwd: "." }],
    "en",
  ),
  /current sandbox and approval policy/,
);
assert.deepEqual(
  findVerificationCandidate(
    [{ command: "npm test", cwd: "." }],
    { command: "npm test", cwd: "." },
  ),
  { command: "npm test", cwd: "." },
);

const selfCheck = {
  completed: true,
  reviewedVersions: new Map([["src/a.js", "b\n"]]),
  report: {
    summary: "done",
    checks: ["syntax"],
    improvements: [],
    remainingRisks: [],
  },
  mode: "legacy",
  segments: [],
  seal: { id: "seal" },
  verificationCandidates: [{ command: "npm test", cwd: "." }],
  verificationAttempted: true,
  verificationPassed: true,
  verificationResults: [{ command: "npm test", exitCode: 0, passed: true }],
};
const result = buildSelfCheckResult(selfCheck, changes);
assert.equal(result.required, true);
assert.equal(result.completed, true);
assert.deepEqual(result.reviewedFiles, ["src/a.js"]);
assert.equal(result.verification.passed, true);

console.log("self-check evidence smoke: PASS");

import assert from "node:assert/strict";
import {
  collectAutomaticUnderstandingCandidates,
  extractAutomaticUnderstandingCandidates,
  fallbackUnderstandingChangesFromCandidates,
} from "../electron/agent-runtime-core.js";

assert.deepEqual(
  extractAutomaticUnderstandingCandidates("你好"),
  [],
  "casual conversation must not pollute Project Understanding",
);

const suggestedCandidate = {
  source: "harness-user-intent",
  category: "preference",
  content: "Use Chinese by default.",
  confidence: 0.88,
  evidence: [{ type: "user", reference: "Current user request" }],
};
assert.deepEqual(
  fallbackUnderstandingChangesFromCandidates({
    candidates: [suggestedCandidate],
    passedVerifications: [],
  }),
  [],
  "Harness-nominated statements must never bypass Curator judgment",
);
assert.equal(
  fallbackUnderstandingChangesFromCandidates({
    candidates: [{ ...suggestedCandidate, source: "parent-agent" }],
    passedVerifications: [],
  }).length,
  1,
  "an explicit parent-agent memory decision may use the validated fallback",
);

const chinese = extractAutomaticUnderstandingCandidates(
  "以后每个任务都默认使用中文回复，并把构建命令作为跨任务理解共享。",
);
assert.equal(chinese.length, 1);
assert.equal(chinese[0].category, "preference");
assert.match(chinese[0].content, /以后每个任务/);

const english = extractAutomaticUnderstandingCandidates(
  "From now on, always run npm test before packaging a release.",
);
assert.equal(english.length, 1);
assert.equal(english[0].category, "decision");
assert.equal(english[0].evidence, "Current user request");

assert.deepEqual(
  extractAutomaticUnderstandingCandidates("修复一下首页的按钮"),
  [],
  "one-off task instructions should not become durable context automatically",
);

const bootstrap = collectAutomaticUnderstandingCandidates(
  [
    { role: "user", content: "以后每个任务都默认使用中文回复。" },
    { role: "assistant", content: "收到。" },
    { role: "user", content: "继续修复首页按钮" },
  ],
  0,
);
assert.equal(bootstrap.length, 1);
assert.match(bootstrap[0].content, /默认使用中文/);

assert.deepEqual(
  collectAutomaticUnderstandingCandidates(
    [
      { role: "user", content: "以后每个任务都默认使用中文回复。" },
      { role: "user", content: "你好" },
    ],
    0,
  ),
  [],
  "a casual latest turn must not trigger historical Understanding bootstrap",
);

console.log("understanding automation smoke: PASS");

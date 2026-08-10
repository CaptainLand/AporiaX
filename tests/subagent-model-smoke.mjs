import assert from "node:assert/strict";
import { createPermissionPolicy } from "../electron/agent-core.js";
import {
  MAX_SUBAGENT_RESULT_CHARS,
  SUBAGENT_ROLE_CONFIG,
  assertSubagentScope,
  compactSubagentEvidence,
  compactSubagentModelResult,
  createSubagentPermissionPolicy,
  normalizeSubagentInput,
  normalizeWorkspaceScope,
  pathIsInsideScope,
  subagentEvidence,
  subagentToolPaths,
  subagentToolsAreParallel,
} from "../electron/runtime/subagent-model.js";

assert.equal(MAX_SUBAGENT_RESULT_CHARS, 24_000);
assert(SUBAGENT_ROLE_CONFIG.verify.tools.has("run_command"));
assert(!SUBAGENT_ROLE_CONFIG.review.tools.has("run_command"));

assert.deepEqual(normalizeWorkspaceScope([]), ["."]);
assert.deepEqual(normalizeWorkspaceScope(["./src/", "src", "docs"]), ["src", "docs"]);
assert.throws(() => normalizeWorkspaceScope(["../secret"]), /inside the workspace/i);
assert.throws(() => normalizeWorkspaceScope(["C:/secret"]), /inside the workspace/i);

assert.deepEqual(
  normalizeSubagentInput({ role: "verify", task: "Run tests", scope: ["."], max_rounds: 5 }),
  {
    role: "verify",
    task: "Run tests",
    scope: ["."],
    background: false,
    maxRounds: 5,
  },
);
assert.throws(() => normalizeSubagentInput({ role: "builder", task: "x" }), /role must be/i);

assert.equal(pathIsInsideScope("src/a.js", ["src"]), true);
assert.equal(pathIsInsideScope("docs/a.md", ["src"]), false);
assert.deepEqual(subagentToolPaths("run_command", { cwd: "src" }), ["src"]);
assert.doesNotThrow(() => assertSubagentScope("read_file", { path: "src/a.js" }, ["src"]));
assert.throws(
  () => assertSubagentScope("read_file", { path: "docs/a.md" }, ["src"]),
  /outside its delegated scope/i,
);
assert.throws(
  () => assertSubagentScope("run_command", { cwd: "src" }, ["src"]),
  /repository-wide scope/i,
);

const parent = createPermissionPolicy("workspace-write");
const verifyPolicy = createSubagentPermissionPolicy(parent, "verify");
assert.equal(verifyPolicy.run_command, "allow");
assert.equal(verifyPolicy.write_file, undefined);

const compacted = compactSubagentModelResult({ stdout: "x".repeat(14_000) });
assert.equal(compacted.truncated, true);
assert(compacted.stdout.length < 14_000);
const evidence = subagentEvidence("run_command", {
  command: "npm test",
  cwd: ".",
  exitCode: 0,
  stdout: "PASS\n",
});
assert.equal(evidence.command, "npm test");
assert.equal(evidence.exitCode, 0);
assert.match(evidence.preview, /PASS/);
assert(compactSubagentEvidence(Array.from({ length: 50 }, (_, index) => ({
  tool: "read_file",
  path: `src/${index}.js`,
  preview: "x".repeat(1_000),
}))).length <= 40);

assert.equal(
  subagentToolsAreParallel([
    { function: { name: "read_file" } },
    { function: { name: "search_text" } },
  ]),
  true,
);
assert.equal(
  subagentToolsAreParallel([
    { function: { name: "read_file" } },
    { function: { name: "run_command" } },
  ]),
  false,
);

console.log("subagent model smoke: PASS");

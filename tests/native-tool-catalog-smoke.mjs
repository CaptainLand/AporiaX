import assert from "node:assert/strict";
import {
  MAX_SEARCH_RESULTS,
  TOOL_DEFINITIONS,
  TOOL_REGISTRY,
  TOOL_RISKS,
} from "../electron/runtime/native-tool-catalog.js";

assert.equal(MAX_SEARCH_RESULTS, 200);
const names = TOOL_DEFINITIONS.map((definition) => definition.function.name);
for (const required of [
  "delegate_subagent",
  "read_file",
  "write_file",
  "run_command",
  "browser_open",
  "browser_click",
  "complete_self_check",
]) {
  assert(names.includes(required), `missing ${required}`);
}

const runCommand = TOOL_DEFINITIONS.find(
  (definition) => definition.function.name === "run_command",
);
assert.deepEqual(runCommand.function.parameters.required, ["command", "cwd"]);
assert(runCommand.function.parameters.properties.reason);
assert.equal(TOOL_RISKS.run_command, "execute");
assert.equal(TOOL_RISKS.browser_click, "control");
assert.equal(TOOL_REGISTRY.get("run_command")?.risk, "execute");
assert.equal(TOOL_REGISTRY.get("read_file")?.risk, "read");

console.log("native tool catalog smoke: PASS");

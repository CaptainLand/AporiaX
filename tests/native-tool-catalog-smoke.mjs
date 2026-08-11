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
  "read_external_file",
  "write_file",
  "start_process",
  "read_process",
  "write_stdin",
  "kill_process",
  "run_command",
  "browser_open",
  "browser_click",
  "request_self_check",
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
assert.equal(TOOL_RISKS.request_self_check, "control");
assert.equal(TOOL_REGISTRY.get("run_command")?.risk, "execute");
assert.equal(TOOL_REGISTRY.get("read_file")?.risk, "read");
assert.equal(TOOL_REGISTRY.get("read_external_file")?.risk, "read");
assert.equal(TOOL_REGISTRY.get("start_process")?.risk, "execute");

const readFileTool = TOOL_DEFINITIONS.find((definition) => definition.function.name === "read_file");
assert(readFileTool.function.parameters.properties.start_line);
assert(readFileTool.function.parameters.properties.offset);
const searchTool = TOOL_DEFINITIONS.find((definition) => definition.function.name === "search_text");
assert(searchTool.function.parameters.properties.mode);
assert(searchTool.function.parameters.properties.include_glob);
const patchTool = TOOL_DEFINITIONS.find((definition) => definition.function.name === "apply_patch");
assert(patchTool.function.parameters.properties.patch);

console.log("native tool catalog smoke: PASS");

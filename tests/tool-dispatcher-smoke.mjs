import assert from "node:assert/strict";
import { ToolRegistry, createPermissionPolicy } from "../electron/agent-core.js";
import {
  dispatchNativeTool,
  projectNativeToolCatalog,
} from "../electron/runtime/tool-dispatcher.js";

const registry = new ToolRegistry([
  {
    risk: "execute",
    definition: {
      type: "function",
      function: {
        name: "run_command",
        description: "Run command",
        parameters: { type: "object", properties: {} },
      },
    },
  },
  {
    risk: "write",
    definition: {
      type: "function",
      function: {
        name: "write_file",
        description: "Write file",
        parameters: { type: "object", properties: {} },
      },
    },
  },
  {
    risk: "read",
    definition: {
      type: "function",
      function: { name: "present_to_user", description: "Show an artifact", parameters: { type: "object" } },
    },
  },
]);

const parseArguments = (toolCall) => JSON.parse(toolCall.function.arguments || "{}");
const commandCall = {
  id: "call-command",
  function: { name: "run_command", arguments: JSON.stringify({ command: "npm test" }) },
};

let approvals = 0;
let executions = 0;
const result = await dispatchNativeTool({
  toolCall: commandCall,
  registry,
  permissionPolicy: createPermissionPolicy("workspace-write"),
  approvalMode: "sandbox-auto",
  sandboxStatus: { localAvailable: true, autoApprovalSafe: true },
  requestApproval: async () => {
    approvals += 1;
    return { approved: true };
  },
  parseArguments,
  executeAuthorized: async ({ input, permissionDecision }) => {
    executions += 1;
    assert.equal(input.command, "npm test");
    assert.equal(permissionDecision.executionMode, "safe-manual-approval");
    assert.equal(permissionDecision.commandPolicy.category, "project-script");
    return { modelResult: { exitCode: 0 } };
  },
});
assert.equal(result.modelResult.exitCode, 0);
assert.equal(approvals, 1);
assert.equal(executions, 1);

await dispatchNativeTool({
  toolCall: commandCall,
  registry,
  permissionPolicy: createPermissionPolicy("workspace-write"),
  approvalMode: "manual",
  sandboxStatus: { localAvailable: true, autoApprovalSafe: true },
  requestApproval: async (request) => {
    approvals += 1;
    assert.equal(request.command, "npm test");
    assert.equal(request.riskCategory, "project-script");
    return { approved: true };
  },
  parseArguments,
  executeAuthorized: async () => ({ modelResult: { exitCode: 0 } }),
});
assert.equal(approvals, 2);

await assert.rejects(
  () =>
    dispatchNativeTool({
      toolCall: commandCall,
      registry,
      permissionPolicy: createPermissionPolicy("read-only"),
      approvalMode: "sandbox-auto",
      sandboxStatus: { localAvailable: true, autoApprovalSafe: true },
      requestApproval: async () => ({ approved: true }),
      parseArguments,
      executeAuthorized: async () => ({ modelResult: {} }),
    }),
  /Permission denied/,
);

const catalog = projectNativeToolCatalog({
  catalog: registry.catalog(createPermissionPolicy("workspace-write")),
  approvalMode: "sandbox-auto",
  sandboxStatus: { available: true, localAvailable: true, autoApprovalSafe: true },
});
assert.equal(catalog.find((tool) => tool.name === "run_command").permission, "ask");
assert.equal(
  catalog.find((tool) => tool.name === "run_command").executionMode,
  "isolated-manual-approval",
);
assert.match(
  catalog.find((tool) => tool.name === "run_command").warning,
  /Docker isolation profile/,
);
assert.equal(catalog.find((tool) => tool.name === "write_file").permission, "allow");

let previewApprovals = 0;
const present = (path, browserPermission, enabled = true) => dispatchNativeTool({
  toolCall: { id: "call-present", function: { name: "present_to_user", arguments: JSON.stringify({ path }) } },
  registry,
  permissionPolicy: createPermissionPolicy("read-only", { browser_open: browserPermission }),
  approvalMode: "smart-auto",
  parseArguments,
  executeContext: { browserPresentationAllowed: enabled },
  requestApproval: async () => { previewApprovals++; return { approved: true }; },
  executeAuthorized: async ({ browserPresentationAllowed }) => ({ modelResult: { browserPresentationAllowed } }),
});
assert.equal((await present("demo.html", "deny")).modelResult.browserPresentationAllowed, false);
assert.equal((await present("demo.html", "ask", false)).modelResult.browserPresentationAllowed, false);
await present("readme.md", "ask");
assert.equal(previewApprovals, 0, "document delivery does not ask for browser permission");
assert.equal((await present("<demo.html>", "ask")).modelResult.browserPresentationAllowed, true);
assert.equal(previewApprovals, 1, "an HTML path honors browser approval");

console.log("tool dispatcher smoke: PASS");

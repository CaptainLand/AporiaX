import { execFileSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

function replaceSection(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const endStart = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || endStart < 0) throw new Error(`${label}: missing section anchor`);
  if (source.indexOf(startMarker, start + 1) >= 0) throw new Error(`${label}: duplicate start anchor`);
  return `${source.slice(0, start)}${replacement}${source.slice(endStart)}`;
}

let runtime = await readFile("electron/agent-runtime-core.js", "utf8");

runtime = replaceOnce(
  runtime,
  `import { createOpenAICompatibleProvider } from "./runtime/provider-stream.js";\n`,
  `import { createOpenAICompatibleProvider } from "./runtime/provider-stream.js";\nimport {\n  buildToolApprovalRequest,\n  resolveToolExecutionPermission,\n} from "./runtime/tool-permissions.js";\n`,
  "tool permission import",
);

runtime = replaceSection(
  runtime,
  `  const permissionAction = getToolPermission(\n    permissionPolicy,\n    toolName,\n  );\n`,
  `\n  if (isBrowserToolName(toolName)) {`,
  `  const permissionAction = getToolPermission(\n    permissionPolicy,\n    toolName,\n  );\n  const permissionDecision = resolveToolExecutionPermission({\n    toolName,\n    permissionAction,\n    approvalMode,\n    sandboxStatus,\n  });\n  if (permissionDecision.denied) {\n    throw new Error(\`Permission denied for tool: \${toolName}\`);\n  }\n  if (permissionDecision.requiresApproval) {\n    const approval = await requestApproval(\n      buildToolApprovalRequest({\n        toolName,\n        descriptor,\n        input,\n        sandboxStatus,\n      }),\n    );\n    throwIfAborted(signal);\n    if (!approval?.approved) {\n      throw new Error(\`The user rejected tool: \${toolName}\`);\n    }\n  }\n`,
  "executeTool approval block",
);

runtime = replaceSection(
  runtime,
  `  const staticToolCatalog = hasWorkspace\n`,
  `  const toolCatalog = [...staticToolCatalog, ...(mcpDiscovery.tools || [])];`,
  `  const staticToolCatalog = hasWorkspace\n    ? TOOL_REGISTRY.catalog(permissionPolicy).map((tool) => {\n        if (tool.name !== "run_command" || !commandToolAvailable) return tool;\n        const decision = resolveToolExecutionPermission({\n          toolName: "run_command",\n          permissionAction: tool.permission,\n          approvalMode: effectiveApprovalMode,\n          sandboxStatus,\n        });\n        return {\n          ...tool,\n          permission: decision.requiresApproval ? "ask" : "allow",\n          executionMode: decision.executionMode,\n          warning: decision.sandboxAutoApproved\n            ? commandUsesContainer\n              ? "Commands run automatically inside the isolated Docker sandbox."\n              : "Commands run automatically in a temporary workspace copy with conflict-checked synchronization."\n            : decision.sandboxSafe\n              ? "Commands use the sandbox but require explicit approval for this task."\n              : "No safe sandbox backend is available. Host execution requires explicit approval.",\n        };\n      })\n    : [];\n`,
  "tool catalog permission projection",
);

runtime = runtime.replaceAll(
  "Use run_command only when a command materially verifies the result.",
  "Use run_command when a command materially helps implement or verify the result.",
);

runtime = replaceOnce(
  runtime,
  "Harness found the following project verification commands. Use run_command to attempt at least one relevant check; command execution still requires user approval:",
  "Harness found the following project verification commands. Use run_command to attempt at least one relevant check; Harness will apply the current sandbox and approval policy:",
  "English self-check approval wording",
);
runtime = replaceOnce(
  runtime,
  "Harness 检测到以下项目验证命令。必须使用 run_command 至少尝试一项最相关的验证；命令仍需用户审批：",
  "Harness 检测到以下项目验证命令。必须使用 run_command 至少尝试一项最相关的验证；Harness 会按当前沙箱与审批策略执行：",
  "Chinese self-check approval wording",
);

await writeFile("electron/agent-runtime-core.js", runtime, "utf8");

let agentDefinitions = execFileSync(
  "git",
  [
    "show",
    "origin/agent/v0.6-streaming-performance:electron/harness/agent-definitions.js",
  ],
  { encoding: "utf8" },
);
agentDefinitions = replaceOnce(
  agentDefinitions,
  `      "Implement one delegated change inside an isolated worktree and explicit non-overlapping write scopes.",`,
  `      "Implement and verify one delegated change inside an isolated worktree and explicit non-overlapping write scopes.",`,
  "builder description",
);
agentDefinitions = replaceOnce(
  agentDefinitions,
  `      "write_file",\n      "apply_patch",\n      "complete_self_check",`,
  `      "write_file",\n      "apply_patch",\n      "run_command",\n      "complete_self_check",`,
  "builder command tool",
);
agentDefinitions = replaceOnce(
  agentDefinitions,
  `      write_file: "allow",\n      apply_patch: "allow",\n      complete_self_check: "allow",`,
  `      write_file: "allow",\n      apply_patch: "allow",\n      run_command: "allow",\n      complete_self_check: "allow",`,
  "builder command permission",
);
agentDefinitions = replaceOnce(
  agentDefinitions,
  `      "Modify only the delegated write scopes. Never broaden the scope, run arbitrary commands, or edit files owned by another Builder.",`,
  `      "Modify only the delegated write scopes. You may run relevant build, test, lint, or typecheck commands inside your isolated worktree to verify the implementation. Never broaden the scope, access unrelated external systems, or edit files owned by another Builder.",`,
  "builder prompt",
);
await writeFile("electron/harness/agent-definitions.js", agentDefinitions, "utf8");

let harnessSmoke = await readFile("tests/harness-v2-smoke.mjs", "utf8");
harnessSmoke = replaceOnce(
  harnessSmoke,
  `assert(!builderDefinition.tools.includes("run_command"));`,
  `assert(builderDefinition.tools.includes("run_command"));`,
  "builder definition command expectation",
);
harnessSmoke = replaceOnce(
  harnessSmoke,
  `assert.equal(getToolPermission(builderPolicy, "run_command"), "deny");`,
  `assert.equal(getToolPermission(builderPolicy, "run_command"), "allow");`,
  "builder permission command expectation",
);
await writeFile("tests/harness-v2-smoke.mjs", harnessSmoke, "utf8");

await rm("scripts/apply-runtime-permission-refactor.mjs", { force: true });
await rm(".github/workflows/validate-runtime-tool-permissions.yml", { force: true });
console.log("runtime permission refactor applied");

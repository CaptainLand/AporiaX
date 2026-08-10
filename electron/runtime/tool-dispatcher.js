import { getToolPermission } from "../agent-core.js";
import {
  buildToolApprovalRequest,
  resolveToolExecutionPermission,
} from "./tool-permissions.js";

function abortError() {
  const error = new Error("The run was interrupted.");
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/**
 * Authoritative boundary for native AporiaX tool authorization.
 *
 * The Agent loop supplies an already-registered tool and an implementation
 * callback. This module owns argument parsing, permission projection, approval,
 * and the handoff into the actual executor. The executor therefore never needs
 * to repeat permission logic.
 */
export async function dispatchNativeTool({
  toolCall,
  registry,
  permissionPolicy,
  approvalMode = "manual",
  requestApproval,
  sandboxStatus = null,
  signal,
  parseArguments,
  executeAuthorized,
  executeContext = {},
} = {}) {
  assertNotAborted(signal);
  const toolName = String(toolCall?.function?.name || "");
  const descriptor = registry?.get?.(toolName) || null;
  if (!descriptor) throw new Error(`Unsupported tool: ${toolName || "unknown"}`);
  if (typeof parseArguments !== "function") {
    throw new Error("Tool dispatcher requires an argument parser.");
  }
  if (typeof executeAuthorized !== "function") {
    throw new Error("Tool dispatcher requires an authorized executor.");
  }

  const input = parseArguments(toolCall);
  const permissionAction = getToolPermission(permissionPolicy, toolName);
  const decision = resolveToolExecutionPermission({
    toolName,
    permissionAction,
    approvalMode,
    sandboxStatus,
  });
  if (decision.denied) {
    throw new Error(`Permission denied for tool: ${toolName}`);
  }

  if (decision.requiresApproval) {
    if (typeof requestApproval !== "function") {
      throw new Error(`Tool ${toolName} requires approval.`);
    }
    const approval = await requestApproval(
      buildToolApprovalRequest({
        toolName,
        descriptor,
        input,
        sandboxStatus,
      }),
    );
    assertNotAborted(signal);
    if (!approval?.approved) {
      throw new Error(`The user rejected tool: ${toolName}`);
    }
  }

  const result = await executeAuthorized({
    ...executeContext,
    toolCall,
    toolName,
    descriptor,
    input,
    signal,
    permissionDecision: decision,
  });
  assertNotAborted(signal);
  return result;
}

export function projectNativeToolCatalog({
  catalog = [],
  approvalMode = "manual",
  sandboxStatus = null,
} = {}) {
  return (catalog || []).map((tool) => {
    if (tool?.name !== "run_command" || tool.permission === "deny") return tool;
    const decision = resolveToolExecutionPermission({
      toolName: "run_command",
      permissionAction: tool.permission,
      approvalMode,
      sandboxStatus,
    });
    return {
      ...tool,
      permission: decision.requiresApproval ? "ask" : "allow",
      executionMode: decision.executionMode,
      warning: decision.sandboxAutoApproved
        ? sandboxStatus?.available
          ? "Commands run automatically inside the isolated Docker sandbox."
          : "Commands run automatically in a temporary workspace copy with conflict-checked synchronization."
        : decision.sandboxSafe
          ? "Commands use the sandbox but require explicit approval for this task."
          : "No safe sandbox backend is available. Host execution requires explicit approval.",
    };
  });
}

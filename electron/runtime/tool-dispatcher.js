import { getToolPermission } from "../agent-core.js";
import { tryReadExternalDirectory } from "./external-read.js";
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
  executionMode = null,
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
    executionMode,
    input,
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
        permissionDecision: decision,
      }),
    );
    assertNotAborted(signal);
    if (!approval?.approved) {
      throw new Error(`The user rejected tool: ${toolName}`);
    }
  }

  if (toolName === "read_external_file") {
    const directoryResult = await tryReadExternalDirectory(input?.path, {
      signal,
    });
    if (directoryResult) {
      assertNotAborted(signal);
      return directoryResult;
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
  executionMode = null,
} = {}) {
  return (catalog || []).map((tool) => {
    if (tool?.name !== "run_command" || tool.permission === "deny") return tool;
    const decision = resolveToolExecutionPermission({
      toolName: "run_command",
      permissionAction: tool.permission,
      approvalMode,
      sandboxStatus,
      executionMode,
      input: {},
    });
    const backend = decision.backend;
    return {
      ...tool,
      permission: decision.requiresApproval ? "ask" : "allow",
      executionMode: decision.executionMode,
      warning:
        backend.mode === "direct"
          ? "Direct execution uses the real workspace and host authority. Only recognized low-risk commands may auto-run; unknown commands require approval."
          : backend.mode === "isolated"
            ? backend.available
              ? "Commands use the Docker isolation profile. Explicit destructive, dependency-mutating, and remote-write commands still require approval."
              : "Docker isolation was selected but is not ready. Command execution remains behind an approval boundary until the isolated backend is available."
            : "Safe execution protects workspace mutations with a temporary copy, but still uses host process and network authority. Unknown commands require approval.",
    };
  });
}

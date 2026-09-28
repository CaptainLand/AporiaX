import { join } from "node:path";
import { createLocalControlService } from "./service.js";
import { createLocalControlServer } from "./server.js";
import { createLocalControlPolicy, withLocalControlPolicy, localControlPolicySnapshot } from "./policy.js";
import { prepareControlWorkspace, finalizeControlWorkspace } from "./workspaces.js";
import { getClientConfiguration } from "./bridge/config.js";
import { planAgentBudget, runWithAgentBudget } from "../harness/agent-budget.js";
import { loadMcpConfiguration } from "../mcp-config.js";
import { TERMINAL_STATES } from "./contracts.js";

// Accepted/queued tasks must keep the desktop busy before the Harness runtime
// is registered, and while final artifacts are being prepared for delivery.
export function createControlActivityTracker() {
  const runs = new Map();
  return {
    observe(event) {
      if (!event?.runId || !event.run) return;
      if (TERMINAL_STATES.has(event.run.status)) runs.delete(event.runId);
      else runs.set(event.runId, { ...event.run, startedAt: event.run.startedAt || event.run.createdAt });
    },
    listRuns() { return [...runs.values()]; },
    combined(runtimeRuns = []) { return [...new Map([...runs, ...runtimeRuns.map(run => [run.runId, run])]).values()]; },
  };
}

// All inputs here come from the main-process service after the desktop user's
// grant has been checked. Never accept renderer/raw HTTP Harness options.
export function createExternalTaskAdapter({ dataDirectory, startHarnessTask, taskRuntime,
  capabilityRegistry = null, loadMcp = loadMcpConfiguration } = {}) {
  const directory = () => typeof dataDirectory === "function" ? dataDirectory() : dataDirectory;
  return {
    async startRun(request, options = {}) {
      const grant = request.externalControl;
      if (!grant || options.clientId !== `external:${grant.clientId}`) throw new Error("A trusted external client grant is required.");
      options.signal?.throwIfAborted();
      const handle = await prepareControlWorkspace({ sourcePath: request.workspacePath,
        dataDirectory: directory(), runId: request.runId,
        writable: grant.permissionProfile === "workspace_edit", signal: options.signal });
      // Persist the execution root before any model or tools can produce output.
      await options.onPrepared?.({ workspacePath: handle.workspacePath, workspace: handle.workspace });
      options.signal?.throwIfAborted();
      const policy = createLocalControlPolicy({ ...grant, runId: request.runId, workspaceRoot: handle.workspacePath,
        onUsage: usage => options.onEvent?.({ type: "local_control.usage", usage }) });
      return withLocalControlPolicy(policy, async () => {
        const writable = grant.permissionProfile === "workspace_edit";
        const mcpEnabled = writable && grant.capabilities.mcp === true;
        const configured = mcpEnabled ? await loadMcp({ userDataDirectory: directory(), workspacePath: handle.workspacePath }) : { servers: [], errors: [] };
        const mcpServers = configured.servers.filter(server => server.enabled !== false && grant.allowedMcpServerIds.includes(server.id));
        const total = grant.limits.maxSubagents;
        const concurrent = Math.min(grant.limits.maxParallelAgents, total);
        const prepared = {
          runId: request.runId, taskId: request.taskId, sourceUserId: `${request.runId}:request`,
          prompt: request.instruction, providerId: request.providerId, modelId: request.modelId,
          messages: [{ id: `${request.runId}:request`, role: "user", content: request.instruction }],
          workspacePath: handle.workspacePath, permission: writable ? "workspace-write" : "read-only",
          executionMode: "safe", approvalMode: "manual", knowledgeEnabled: false,
          builderLimit: writable ? concurrent : 0,
          agentBudget: { maxTotalSubagents: total, maxActiveSubagents: concurrent,
            roles: { explore: total, review: total, verify: total, other: total, curator: 0, builder: writable ? total : 0 } },
          extensionPolicy: { skill: false, mcp: mcpEnabled, browser: writable && grant.capabilities.browser === true },
          mcpServers, mcpConfigErrors: [], capabilityRegistry,
        };
        options.signal?.throwIfAborted();
        const descriptor = await runWithAgentBudget(planAgentBudget(prepared), {}, () => startHarnessTask(prepared, {
          clientId: options.clientId, detached: true, signal: options.signal, strictProvider: true,
          onEvent: options.onEvent, onResult: options.onResult,
          transformResult: async result => finalizeControlWorkspace(handle,
            { ...result, controlUsage: localControlPolicySnapshot(policy) }),
        }));
        return { ...descriptor, workspacePath: handle.workspacePath, workspace: handle.workspace };
      });
    },
    // External guidance is literal text. Desktop @browser/@skill expansion
    // may read shared user context and is deliberately not an API capability.
    steerRun(runId, message, context) { return taskRuntime.steer(runId, message, context); },
  };
}

// Electron-free lifecycle adapter: also exercised with the real HTTP listener
// and durable task runtime by integration tests.
export async function createDesktopLocalControl({ dataDirectory, taskRuntime, startHarnessTask,
  listProviders, capabilityRegistry, execPath, bridgePath, onEvent = () => {}, ...adapters } = {}) {
  const taskAdapter = createExternalTaskAdapter({ dataDirectory, taskRuntime, startHarnessTask, capabilityRegistry, ...adapters });
  const service = await createLocalControlService({ dataDirectory, taskRuntime, listProviders, ...taskAdapter });
  const server = createLocalControlServer({ service });
  const unsubscribe = service.subscribe(onEvent);
  let tail = Promise.resolve();
  let closed = false;
  const serialize = callback => {
    const operation = tail.catch(() => {}).then(callback);
    tail = operation;
    return operation;
  };
  async function reconcileListener() {
    if (service.enabled) {
      try { await server.listen(); await service.setEndpoint(server.url); }
      catch (error) {
        await server.close();
        await service.admin("setEnabled", { enabled: false });
        await service.setEndpoint(null);
        throw error;
      }
    } else {
      await server.close();
      await service.setEndpoint(null);
    }
  }
  try { await reconcileListener(); }
  catch (error) { onEvent({ type: "control.error", message: error.message }); }
  return {
    async request({ action, input = {} } = {}) {
      if (closed) throw new Error("Local control is shutting down.");
      if (action === "setEnabled") return serialize(async () => {
        const result = await service.admin(action, input);
        await reconcileListener();
        return result;
      });
      const result = await service.admin(action, input);
      if (action !== "createClient") return result;
      const config = getClientConfiguration({ execPath, bridgePath, connectionPath: result.connectionFile });
      const apiBaseUrl = server.url ? `${server.url}/control/v1` : "";
      return { ...result, connectionConfig: {
        mcpJson: JSON.stringify(config.mcpConfig, null, 2), codexToml: config.codexToml, apiBaseUrl,
        apiExample: `curl --header 'Authorization: Bearer <CLIENT_TOKEN>' '${apiBaseUrl || "http://127.0.0.1:<PORT>/control/v1"}/meta'`,
      } };
    },
    shutdown() { return serialize(async () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      await server.close();
      await service.shutdown();
    }); },
  };
}

export function desktopControlBridgePath({ isPackaged, resourcesPath, appPath }) {
  return isPackaged ? join(resourcesPath, "control-bridge.cjs") : join(appPath, "electron", "control", "bridge", "entry.js");
}

import { app, dialog, ipcMain } from "electron";
import { join } from "node:path";
import "./account/register-desktop-account-ipc.js";
import { installDesktopBackground } from "./desktop-background.js";
import { createHarnessKernel } from "./harness/kernel.js";
import { createHarnessCoreServer } from "./harness/core-server.js";
import { setDefaultHarnessEventBus } from "./harness/event-bus.js";
import {
  capabilityAvailability,
  extensionSourceEnabled,
  loadExtensionPolicy,
  setExtensionSourceEnabled,
} from "./harness/extension-policy.js";
import {
  planAgentBudget,
  runWithAgentBudget,
} from "./harness/agent-budget.js";
import {
  TOOL_DEFINITIONS,
  TOOL_RISKS,
} from "./runtime/native-tool-catalog.js";
import { prepareVisionProxyRequest } from "./vision-proxy.js";
import { exposeVisionProxyCapabilities } from "./vision-proxy-core.js";
import {
  prepareWorkspaceMentionMessage,
  prepareWorkspaceMentionRequest,
} from "./workspace-mentions.js";
import {
  prepareSkillMessage,
  prepareSkillRequest,
  skillActivationSummary,
} from "./skill-runtime.js";
import {
  loadMcpConfiguration,
  publicMcpServerSummary,
} from "./mcp-config.js";
import { selectMentionedMcpServers } from "./mcp-mentions.js";
import {
  extensionLibrarySnapshot,
  importMcpConfiguration,
  importUserSkill,
  installCatalogSkill,
  removeMcpServer,
  removeUserSkill,
  saveMcpServer,
} from "./extension-library.js";

const desktopBackground = installDesktopBackground();
const activeRunMetadata = new Map();
let kernel = null;

function nativeToolDescriptors() {
  return TOOL_DEFINITIONS.map((definition) => {
    const name = definition.function.name;
    return {
      definition,
      risk: TOOL_RISKS[name],
      source: name.startsWith("browser_") ? "browser" : "native",
    };
  });
}

function skillRuntimeOptions(workspacePath = "") {
  return {
    registry: kernel?.skills || null,
    workspacePath,
    userSkillsDirectory: join(app.getPath("userData"), "skills"),
  };
}

function mcpConfigurationOptions(workspacePath = "") {
  return {
    userDataDirectory: app.getPath("userData"),
    workspacePath,
  };
}

function extensionPolicyOptions(workspacePath = "") {
  return {
    userDataDirectory: app.getPath("userData"),
    workspacePath,
  };
}

function seedSkillOriginalContent(request = {}) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const targetIndex = request?.sourceUserId
    ? messages.findIndex(
        (message) =>
          message?.role === "user" && message?.id === request.sourceUserId,
      )
    : -1;
  const userIndex =
    targetIndex >= 0
      ? targetIndex
      : messages.findLastIndex((message) => message?.role === "user");
  if (userIndex < 0) return request;
  const nextMessages = [...messages];
  nextMessages[userIndex] = {
    ...messages[userIndex],
    skillOriginalContent: String(messages[userIndex]?.content || ""),
  };
  return { ...request, messages: nextMessages };
}

function emitSkillStatus(event, request, activatedSkills = [], unresolved = []) {
  const runId = String(request?.runId || "").trim();
  if (!runId || (!activatedSkills.length && !unresolved.length)) return;
  const payload = {
    type: activatedSkills.length ? "skill.activated" : "skill.unresolved",
    taskId: request?.taskId || null,
    assistantId: request?.assistantId || null,
    skills: activatedSkills,
    unresolved,
  };
  if (event?.sender && !event.sender.isDestroyed()) {
    event.sender.send("harness:event", { runId, ...payload });
  }
  kernel?.events.emit({ runId, ...payload });
}

async function prepareHarnessRunRequest(event, request = {}) {
  const workspacePath = String(request?.workspacePath || "").trim();
  const policy = await loadExtensionPolicy(extensionPolicyOptions(workspacePath));
  const seededRequest = seedSkillOriginalContent(request);
  const visionPreparedRequest = await prepareVisionProxyRequest(seededRequest);
  const mentionPreparedRequest = await prepareWorkspaceMentionRequest(visionPreparedRequest);
  const skillPreparedRequest = extensionSourceEnabled(policy, "skill")
    ? await prepareSkillRequest(
        mentionPreparedRequest,
        skillRuntimeOptions(workspacePath),
      )
    : mentionPreparedRequest;
  emitSkillStatus(
    event,
    skillPreparedRequest,
    skillActivationSummary(skillPreparedRequest),
    skillPreparedRequest?.unresolvedSkills || [],
  );
  const mcpConfiguration = await loadMcpConfiguration(
    mcpConfigurationOptions(workspacePath),
  );
  const mcpSelection = selectMentionedMcpServers(
    skillPreparedRequest,
    mcpConfiguration.servers,
  );
  return {
    ...skillPreparedRequest,
    mcpServers: extensionSourceEnabled(policy, "mcp")
      ? mcpSelection.servers
      : [],
    mcpConfigErrors: [
      ...mcpConfiguration.errors,
      ...mcpSelection.unresolved.map(
        (id) => `Mentioned MCP server is not available: ${id}`,
      ),
    ],
    activatedMcpServers: mcpSelection.mentions,
    extensionPolicy: policy.effective,
    capabilityRegistry: kernel?.capabilitiesRegistry || null,
  };
}

const nativeHandle = ipcMain.handle.bind(ipcMain);
const originalHandle = ipcMain.handle;
ipcMain.handle = function budgetAwareHandle(channel, listener) {
  if (channel === "providers:list") {
    return nativeHandle(channel, async (...args) =>
      exposeVisionProxyCapabilities(await listener(...args)),
    );
  }
  if (channel === "harness:steer") {
    return nativeHandle(channel, async (event, request = {}) => {
      const runId = String(request?.runId || "").trim();
      const metadata = activeRunMetadata.get(runId);
      const workspacePath = metadata?.workspacePath || "";
      if (!workspacePath || !request?.message) {
        return listener(event, request);
      }
      const policy = await loadExtensionPolicy(extensionPolicyOptions(workspacePath));
      const mentionedMessage = await prepareWorkspaceMentionMessage(
        request.message,
        workspacePath,
      );
      const message = extensionSourceEnabled(policy, "skill")
        ? await prepareSkillMessage(
            mentionedMessage,
            workspacePath,
            skillRuntimeOptions(workspacePath),
          )
        : mentionedMessage;
      const skills = (message?.activatedSkills || []).map((skill) => ({
        name: skill.name,
        title: skill.title,
        source: skill.source,
        reason: skill.reason,
        tools: [...(skill.tools || [])],
      }));
      emitSkillStatus(
        event,
        {
          ...request,
          taskId: metadata?.taskId,
          assistantId: metadata?.assistantId,
        },
        skills,
        message?.unresolvedSkills || [],
      );
      return listener(event, { ...request, message });
    });
  }
  if (channel !== "harness:run") return nativeHandle(channel, listener);
  return nativeHandle(channel, async (event, request) => {
    const budget = planAgentBudget(request || {});
    const runId = String(request?.runId || "").trim();
    const workspacePath = String(request?.workspacePath || "").trim();
    desktopBackground.runStarted(runId);
    if (runId) {
      activeRunMetadata.set(runId, {
        workspacePath,
        taskId: request?.taskId || null,
        assistantId: request?.assistantId || null,
      });
    }
    try {
      const preparedRequest = await prepareHarnessRunRequest(event, request);
      return await runWithAgentBudget(budget, {}, () =>
        listener(event, preparedRequest),
      );
    } finally {
      activeRunMetadata.delete(runId);
      desktopBackground.runFinished(runId);
    }
  });
};

const desktopMain = await import("./main.js");
ipcMain.handle = originalHandle;

kernel = createHarnessKernel({
  toolDescriptors: nativeToolDescriptors(),
  taskRuntime: desktopMain.harnessTaskRuntime,
});
setDefaultHarnessEventBus(kernel.events);
desktopBackground.attachEventBus(kernel.events);
desktopMain.harnessTaskRuntime.setTaskStarter(async (request, context = {}) => {
  const budget = planAgentBudget(request || {});
  const preparedRequest = await prepareHarnessRunRequest(null, request);
  return runWithAgentBudget(budget, {}, () =>
    desktopMain.startHarnessTask(preparedRequest, context),
  );
});
const coreServer = createHarnessCoreServer({ kernel });

ipcMain.handle("core:status", () => ({
  running: Boolean(coreServer.url),
  url: coreServer.url,
  capabilities: kernel.capabilities(),
  capabilitySummary: kernel.capabilitiesRegistry.summary(),
}));
ipcMain.handle("core:capabilities", async (_event, request = {}) => {
  const workspacePath = String(request?.workspacePath || "").trim();
  const policy = await loadExtensionPolicy(extensionPolicyOptions(workspacePath));
  const capabilities = kernel.capabilitiesRegistry.list({
    kind: request?.kind || "",
    source: request?.source || "",
    scopeId: request?.scopeId || "",
  }).map((capability) => ({
    ...capability,
    availability: capabilityAvailability(capability, policy),
  }));
  return {
    capabilities,
    summary: kernel.capabilitiesRegistry.summary(),
    policy,
  };
});
ipcMain.handle("core:agents", () => ({ agents: kernel.agents.list() }));
ipcMain.handle("core:plugins", () => ({ plugins: kernel.plugins.list() }));
ipcMain.handle("core:extension-policy", async (_event, request = {}) => {
  const workspacePath = String(request?.workspacePath || "").trim();
  return loadExtensionPolicy(extensionPolicyOptions(workspacePath));
});
ipcMain.handle("core:set-extension-policy", async (_event, request = {}) => {
  await setExtensionSourceEnabled({
    userDataDirectory: app.getPath("userData"),
    source: request?.source,
    enabled: request?.enabled,
  });
  const workspacePath = String(request?.workspacePath || "").trim();
  return loadExtensionPolicy(extensionPolicyOptions(workspacePath));
});
ipcMain.handle("core:skills", async (_event, request = {}) => {
  const workspacePath = String(request?.workspacePath || "").trim();
  const policy = await loadExtensionPolicy(extensionPolicyOptions(workspacePath));
  const userSkillsDirectory = join(app.getPath("userData"), "skills");
  const projectSkillsDirectory = workspacePath
    ? join(workspacePath, ".aporiax", "skills")
    : null;
  const skills = await kernel.skills.discover({
    workspacePath,
    userSkillsDirectory,
  });
  const scopeId = `skills:${workspacePath || "global"}`;
  kernel.capabilitiesRegistry.unregisterScope(scopeId);
  if (extensionSourceEnabled(policy, "skill")) {
    for (const skill of skills) {
      kernel.capabilitiesRegistry.upsert({
        kind: "skill",
        source: "skill",
        name: skill.name,
        title: skill.title || skill.name,
        description: skill.description || "",
        risk: "none",
        scopeId,
        tags: [skill.source || "skill", skill.auto ? "auto" : "manual"],
        metadata: {
          auto: Boolean(skill.auto),
          tools: [...(skill.tools || [])],
        },
      });
    }
  }
  return {
    skills,
    enabled: extensionSourceEnabled(policy, "skill"),
    policy,
    userSkillsDirectory,
    projectSkillsDirectory,
    manualInvocation: "@skill:name or /skill:name",
  };
});
ipcMain.handle("core:mcp", async (_event, request = {}) => {
  const workspacePath = String(request?.workspacePath || "").trim();
  const policy = await loadExtensionPolicy(extensionPolicyOptions(workspacePath));
  const configuration = await loadMcpConfiguration(
    mcpConfigurationOptions(workspacePath),
  );
  return {
    servers: extensionSourceEnabled(policy, "mcp")
      ? configuration.servers.map(publicMcpServerSummary)
      : [],
    allServers: configuration.allServers.map(publicMcpServerSummary),
    enabled: extensionSourceEnabled(policy, "mcp"),
    policy,
    errors: configuration.errors,
    userConfigPath: configuration.userConfigPath,
    projectConfigPath: configuration.projectConfigPath,
    projectSelection: configuration.projectSelection,
  };
});
ipcMain.handle("core:library", async (_event, request = {}) =>
  extensionLibrarySnapshot({
    userDataDirectory: app.getPath("userData"),
    workspacePath: String(request?.workspacePath || "").trim(),
  }),
);
ipcMain.handle("core:library:install-skill", async (_event, request = {}) =>
  installCatalogSkill({
    userDataDirectory: app.getPath("userData"),
    catalogId: request?.catalogId,
  }),
);
ipcMain.handle("core:library:import-skill", async () => {
  const selection = await dialog.showOpenDialog({
    title: "Import AporiaX Skill folder",
    properties: ["openDirectory"],
  });
  if (selection.canceled || !selection.filePaths[0]) return { canceled: true };
  return importUserSkill({
    userDataDirectory: app.getPath("userData"),
    sourceDirectory: selection.filePaths[0],
  });
});
ipcMain.handle("core:library:remove-skill", async (_event, request = {}) =>
  removeUserSkill({
    userDataDirectory: app.getPath("userData"),
    name: request?.name,
  }),
);
ipcMain.handle("core:library:save-mcp", async (_event, request = {}) =>
  saveMcpServer({
    userDataDirectory: app.getPath("userData"),
    server: request?.server,
  }),
);
ipcMain.handle("core:library:import-mcp", async () => {
  const selection = await dialog.showOpenDialog({
    title: "Import MCP configuration",
    properties: ["openFile"],
    filters: [{ name: "JSON configuration", extensions: ["json"] }],
  });
  if (selection.canceled || !selection.filePaths[0]) return { canceled: true };
  return importMcpConfiguration({
    userDataDirectory: app.getPath("userData"),
    sourcePath: selection.filePaths[0],
  });
});
ipcMain.handle("core:library:remove-mcp", async (_event, request = {}) =>
  removeMcpServer({
    userDataDirectory: app.getPath("userData"),
    id: request?.id,
  }),
);
ipcMain.handle("core:sessions", () => ({ sessions: kernel.sessions.list() }));
ipcMain.handle("core:events", (_event, request = {}) => ({
  events: kernel.events.history(request),
}));
ipcMain.handle("core:tasks", () => desktopMain.harnessTaskRuntime.snapshot());
ipcMain.handle("core:agent-budget", (_event, request = {}) => ({
  budget: planAgentBudget(request),
}));
ipcMain.handle("desktop:background-status", () => desktopBackground.snapshot());

app.whenReady().then(() => coreServer.listen()).catch(() => undefined);
app.on("before-quit", () => {
  coreServer.close().catch(() => undefined);
});

export {
  kernel as harnessKernel,
  coreServer as harnessCoreServer,
  desktopBackground,
};
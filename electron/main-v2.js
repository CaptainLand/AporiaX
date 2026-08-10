import { app, ipcMain } from "electron";
import { join } from "node:path";
import { installDesktopBackground } from "./desktop-background.js";
import { createHarnessKernel } from "./harness/kernel.js";
import { createHarnessCoreServer } from "./harness/core-server.js";
import { setDefaultHarnessEventBus } from "./harness/event-bus.js";
import {
  planAgentBudget,
  runWithAgentBudget,
} from "./harness/agent-budget.js";
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

const desktopBackground = installDesktopBackground();
const activeRunMetadata = new Map();
let kernel = null;

function skillRuntimeOptions(workspacePath = "") {
  return {
    registry: kernel?.skills || null,
    workspacePath,
    userSkillsDirectory: join(app.getPath("userData"), "skills"),
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
  if (!event.sender.isDestroyed()) {
    event.sender.send("harness:event", { runId, ...payload });
  }
  kernel?.events.emit({ runId, ...payload });
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
      const mentionedMessage = await prepareWorkspaceMentionMessage(
        request.message,
        workspacePath,
      );
      const message = await prepareSkillMessage(
        mentionedMessage,
        workspacePath,
        skillRuntimeOptions(workspacePath),
      );
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
      // Preserve the original user text for deterministic Skill matching.
      // Vision runs first, so a separate visual Provider sees only the original
      // user prompt/image. @file contents are added next, and only then are the
      // selected Skill instructions disclosed to the main Agent. Each stage
      // appends to the request copy instead of replacing prior context.
      const seededRequest = seedSkillOriginalContent(request);
      const visionPreparedRequest = await prepareVisionProxyRequest(
        seededRequest,
      );
      const mentionPreparedRequest = await prepareWorkspaceMentionRequest(
        visionPreparedRequest,
      );
      const preparedRequest = await prepareSkillRequest(
        mentionPreparedRequest,
        skillRuntimeOptions(workspacePath),
      );
      emitSkillStatus(
        event,
        preparedRequest,
        skillActivationSummary(preparedRequest),
        preparedRequest?.unresolvedSkills || [],
      );
      return await runWithAgentBudget(budget, {}, () =>
        listener(event, preparedRequest),
      );
    } finally {
      activeRunMetadata.delete(runId);
      desktopBackground.runFinished(runId);
    }
  });
};

await import("./main.js");
ipcMain.handle = originalHandle;

kernel = createHarnessKernel();
setDefaultHarnessEventBus(kernel.events);
const coreServer = createHarnessCoreServer({ kernel });

ipcMain.handle("core:status", () => ({
  running: Boolean(coreServer.url),
  url: coreServer.url,
  capabilities: kernel.capabilities(),
}));
ipcMain.handle("core:agents", () => ({ agents: kernel.agents.list() }));
ipcMain.handle("core:plugins", () => ({ plugins: kernel.plugins.list() }));
ipcMain.handle("core:skills", async (_event, request = {}) => {
  const workspacePath = String(request?.workspacePath || "").trim();
  const userSkillsDirectory = join(app.getPath("userData"), "skills");
  const projectSkillsDirectory = workspacePath
    ? join(workspacePath, ".aporiax", "skills")
    : null;
  const skills = await kernel.skills.discover({
    workspacePath,
    userSkillsDirectory,
  });
  return {
    skills,
    userSkillsDirectory,
    projectSkillsDirectory,
    manualInvocation: "/skill:name",
  };
});
ipcMain.handle("core:sessions", () => ({ sessions: kernel.sessions.list() }));
ipcMain.handle("core:events", (_event, request = {}) => ({
  events: kernel.events.history(request),
}));
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

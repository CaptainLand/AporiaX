import {
  BrowserWindow,
  Notification,
  app,
  dialog,
  ipcMain,
  safeStorage,
  shell,
} from "electron";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listWorkspaceTree,
  readWorkspacePreview,
  restoreWorkspaceAnchor,
  revertWorkspaceChanges,
  runHarness,
  saveWorkspaceTextFile,
} from "./agent-runtime.js";
import { parseAttachment } from "./attachment-parser.js";
import {
  APORIA_CLOUD_PROVIDER_ID,
  DEFAULT_DEEPSEEK_PROVIDER,
  createAporiaCloudProvider,
  discoverProviderModels,
  normalizeProviderInput,
  publicProviderSummary,
} from "./provider-config.js";
import { getDesktopAccountRuntime } from "./account/register-desktop-account-ipc.js";
import {
  getSandboxStatus,
  prepareSandbox,
} from "./sandbox-runtime.js";
import { createHarnessTaskRuntime } from "./harness/task-runtime.js";
import { createProjectUnderstandingStore } from "./project-understanding.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(currentDirectory, "..");
const isDevelopment = process.argv.includes("--dev");

let mainWindow = null;
let completionFlashTimer = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (app.isReady()) createMainWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}
const RUN_SCOPED_BROWSER_TOOLS = new Set([
  "browser_click",
  "browser_fill",
  "browser_press",
]);

function approvalGrantKey(details = {}) {
  return RUN_SCOPED_BROWSER_TOOLS.has(details.toolName)
    ? "browser-control"
    : "";
}

const harnessTaskRuntime = createHarnessTaskRuntime({
  dataDirectory: () => app.getPath("userData"),
  approvalGrantKey,
  onIdle: () => {
    setImmediate(() => {
      if (
        process.platform !== "darwin" &&
        app.isReady() &&
        !harnessTaskRuntime.hasActiveRuns() &&
        (!mainWindow || mainWindow.isDestroyed())
      ) {
        app.quit();
      }
    });
  },
});

function assertTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Rejected IPC request from an unknown renderer.");
  }
}

function getCredentialPath() {
  return join(app.getPath("userData"), "deepseek-credentials.json");
}

function getProviderStorePath() {
  return join(app.getPath("userData"), "aporiax-providers.json");
}

function getTasksPath() {
  return join(app.getPath("userData"), "aporiax-tasks.json");
}

function getLegacyTasksPath() {
  return join(app.getPath("userData"), "deepagent-tasks.json");
}

function getProjectUnderstandingDirectory() {
  return join(app.getPath("userData"), "project-understanding");
}

async function openProjectUnderstanding(workspacePath) {
  if (
    typeof workspacePath !== "string" ||
    !workspacePath.trim() ||
    workspacePath.includes("\0")
  ) {
    throw new Error("A valid workspace directory is required.");
  }
  const workspaceRoot = await realpath(resolve(workspacePath));
  const stats = await lstat(workspaceRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("The workspace must be a real directory.");
  }
  return createProjectUnderstandingStore({
    baseDirectory: getProjectUnderstandingDirectory(),
    workspaceRoot,
  });
}

async function readStoredProviders() {
  try {
    const store = JSON.parse(
      await readFile(getProviderStorePath(), "utf8"),
    );
    return Array.isArray(store?.providers) ? store.providers : [];
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error("Unable to read the saved model providers.", {
        cause: error,
      });
    }
  }

  try {
    const legacy = JSON.parse(
      await readFile(getCredentialPath(), "utf8"),
    );
    if (!legacy?.encryptedKey) return [];
    const migrated = [
      {
        ...DEFAULT_DEEPSEEK_PROVIDER,
        models: DEFAULT_DEEPSEEK_PROVIDER.models.map((model) => ({
          ...model,
        })),
        encryptedKey: legacy.encryptedKey,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    await writeStoredProviders(migrated);
    return migrated;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error("Unable to migrate the saved DeepSeek credential.", {
      cause: error,
    });
  }
}

async function writeStoredProviders(providers) {
  const serialized = JSON.stringify({
    version: 2,
    providers,
  });
  if (Buffer.byteLength(serialized, "utf8") > 2_000_000) {
    throw new Error("Provider configuration exceeds the storage limit.");
  }
  await mkdir(dirname(getProviderStorePath()), { recursive: true });
  await writeFile(getProviderStorePath(), serialized, "utf8");
}

async function loadProviderRecords() {
  const providers = await readStoredProviders();
  const environmentKey = String(
    process.env.DEEPSEEK_API_KEY || "",
  ).trim();
  if (!environmentKey) return providers;
  const index = providers.findIndex(
    (provider) => provider.id === DEFAULT_DEEPSEEK_PROVIDER.id,
  );
  if (index >= 0) {
    return providers.map((provider, providerIndex) =>
      providerIndex === index
        ? { ...provider, environmentKey: true }
        : provider,
    );
  }
  return [
    {
      ...DEFAULT_DEEPSEEK_PROVIDER,
      models: DEFAULT_DEEPSEEK_PROVIDER.models.map((model) => ({
        ...model,
      })),
      environmentKey: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    ...providers,
  ];
}

function decryptProviderKey(record) {
  if (record.environmentKey) {
    return String(process.env.DEEPSEEK_API_KEY || "").trim();
  }
  if (!record.encryptedKey) return "";
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable on this device.");
  }
  return safeStorage.decryptString(
    Buffer.from(record.encryptedKey, "base64"),
  );
}

function publicAporiaCloudProvider() {
  const account = getDesktopAccountRuntime();
  return publicProviderSummary(
    createAporiaCloudProvider(account.modelGatewayBaseUrl),
  );
}

async function resolveProvider(providerId) {
  if (providerId === APORIA_CLOUD_PROVIDER_ID) {
    const account = getDesktopAccountRuntime();
    return {
      ...publicAporiaCloudProvider(),
      authenticatedFetch: (path, init) =>
        account.fetchModelGateway(path, init),
    };
  }

  const providers = await loadProviderRecords();
  const selected =
    providers.find((provider) => provider.id === providerId) ||
    providers[0];
  if (!selected) {
    throw new Error("尚未配置模型 API，请先添加一个 Provider，或登录 Aporia Account 使用 Aporia Cloud。");
  }
  return {
    ...publicProviderSummary(selected),
    apiKey: decryptProviderKey(selected),
  };
}

async function saveProvider(input) {
  if (input?.id === APORIA_CLOUD_PROVIDER_ID || input?.kind === "aporia-cloud") {
    throw new Error("Aporia Cloud 由 Aporia Account 管理，不能作为自定义 Provider 修改。");
  }
  const storedProviders = await readStoredProviders();
  const existing = storedProviders.find(
    (provider) => provider.id === input?.id,
  );
  if (existing?.environmentKey) {
    throw new Error("环境变量 Provider 不能在应用内修改。");
  }
  const normalized = normalizeProviderInput(input, existing);
  const apiKey = String(input?.apiKey || "").trim();
  if (apiKey.length > 2_000) {
    throw new Error("API Key 长度超过安全限制。");
  }
  let encryptedKey = existing?.encryptedKey || "";
  if (apiKey) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "Secure credential storage is unavailable on this device.",
      );
    }
    encryptedKey = safeStorage
      .encryptString(apiKey)
      .toString("base64");
  }
  const nextRecord = {
    ...normalized,
    encryptedKey,
  };
  const nextProviders = existing
    ? storedProviders.map((provider) =>
        provider.id === existing.id ? nextRecord : provider,
      )
    : [...storedProviders, nextRecord];
  await writeStoredProviders(nextProviders);
  return publicProviderSummary(nextRecord);
}

async function removeProvider(providerId) {
  if (providerId === APORIA_CLOUD_PROVIDER_ID) return false;
  const providers = await readStoredProviders();
  const nextProviders = providers.filter(
    (provider) => provider.id !== providerId,
  );
  if (nextProviders.length === providers.length) return false;
  await writeStoredProviders(nextProviders);
  return true;
}

async function loadApiKey() {
  try {
    return (await resolveProvider("deepseek")).apiKey || null;
  } catch {
    return null;
  }
}

async function saveApiKey(apiKey) {
  return saveProvider({
    ...DEFAULT_DEEPSEEK_PROVIDER,
    apiKey,
  });
}

async function loadTasks() {
  for (const tasksPath of [getTasksPath(), getLegacyTasksPath()]) {
    try {
      const tasks = JSON.parse(await readFile(tasksPath, "utf8"));
      return Array.isArray(tasks) ? tasks : [];
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error("Unable to read saved tasks.", { cause: error });
      }
    }
  }
  return null;
}

async function saveTasks(tasks) {
  if (!Array.isArray(tasks)) {
    throw new Error("Tasks must be an array.");
  }
  const serialized = JSON.stringify(tasks);
  if (Buffer.byteLength(serialized, "utf8") > 50_000_000) {
    throw new Error("Task history exceeds the 50 MB storage limit.");
  }
  await mkdir(dirname(getTasksPath()), { recursive: true });
  await writeFile(getTasksPath(), serialized, "utf8");
}

function sendHarnessEvent(event, runId, payload) {
  if (!event?.sender || event.sender.isDestroyed()) return;
  event.sender.send("harness:event", { runId, ...payload });
}

function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(
    "desktop:window-state",
    mainWindow.isMaximized(),
  );
}

function applyWindowTheme(theme) {
  const normalizedTheme = theme === "dark" ? "dark" : "light";
  if (!mainWindow || mainWindow.isDestroyed()) return normalizedTheme;
  const dark = normalizedTheme === "dark";
  mainWindow.setBackgroundColor(dark ? "#15111b" : "#eef3f7");
  if (
    process.platform !== "darwin" &&
    typeof mainWindow.setTitleBarOverlay === "function"
  ) {
    mainWindow.setTitleBarOverlay({
      color: dark ? "#1b1622" : "#edf2f6",
      symbolColor: dark ? "#f0edf3" : "#303438",
      height: 38,
    });
  }
  return normalizedTheme;
}

function focusTask(taskId) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.flashFrame(false);
  if (completionFlashTimer) {
    clearTimeout(completionFlashTimer);
    completionFlashTimer = null;
  }
  mainWindow.webContents.send("desktop:task-requested", { taskId });
}

function notifyTaskCompleted(payload) {
  const taskId =
    typeof payload?.taskId === "string" ? payload.taskId.slice(0, 100) : "";
  const title =
    typeof payload?.title === "string" && payload.title.trim()
      ? payload.title.trim().slice(0, 120)
      : "AporiaX · Task completed";
  const body =
    typeof payload?.body === "string"
      ? payload.body.trim().slice(0, 240)
      : "";

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(true);
    if (completionFlashTimer) clearTimeout(completionFlashTimer);
    completionFlashTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.flashFrame(false);
      }
      completionFlashTimer = null;
    }, 2400);
  }

  if (!Notification.isSupported()) {
    return { flashed: true, notified: false };
  }
  const notification = new Notification({
    title,
    body,
    icon: join(projectRoot, "build", "icon.ico"),
    silent: false,
  });
  notification.on("click", () => focusTask(taskId));
  notification.show();
  return { flashed: true, notified: true };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: "AporiaX",
    width: 1500,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    titleBarStyle: "hidden",
    ...(process.platform !== "darwin"
      ? {
          titleBarOverlay: {
            color: "#1b1622",
            symbolColor: "#f0edf3",
            height: 38,
          },
        }
      : {}),
    resizable: true,
    maximizable: true,
    minimizable: true,
    icon: join(projectRoot, "build", "icon.ico"),
    backgroundColor: "#15111b",
    webPreferences: {
      preload: join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowedDevelopmentUrl =
      isDevelopment && url.startsWith("http://127.0.0.1:5173");
    const allowedProductionUrl =
      !isDevelopment && url.startsWith("file://");
    if (!allowedDevelopmentUrl && !allowedProductionUrl) {
      event.preventDefault();
    }
  });

  mainWindow.on("maximize", sendWindowState);
  mainWindow.on("unmaximize", sendWindowState);
  mainWindow.on("focus", () => {
    mainWindow?.flashFrame(false);
    if (completionFlashTimer) {
      clearTimeout(completionFlashTimer);
      completionFlashTimer = null;
    }
  });
  mainWindow.webContents.on("did-finish-load", sendWindowState);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (isDevelopment) {
    void mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    void mainWindow.loadFile(join(projectRoot, "dist", "index.html"));
  }
}

async function startHarnessTask(
  request,
  { clientId = "", onEvent = null, detached = false } = {},
) {
  const runId = typeof request?.runId === "string" ? request.runId : "";
  if (!runId || runId.length > 100) {
    throw new Error("A valid run id is required.");
  }
  if (harnessTaskRuntime.getActiveRun(runId)) {
    throw new Error("This Harness run is already active.");
  }

  const provider = await resolveProvider(request?.providerId);
  let recoveryContext = null;
  if (request?.recoveryRunId) {
    recoveryContext = await harnessTaskRuntime.recoveryContext(
      request.recoveryRunId,
    );
    if (
      recoveryContext.taskId &&
      request?.taskId &&
      recoveryContext.taskId !== request.taskId
    ) {
      throw new Error("The recovery checkpoint belongs to another task.");
    }
    if (
      recoveryContext.workspacePath &&
      request?.workspacePath &&
      resolve(recoveryContext.workspacePath) !== resolve(request.workspacePath)
    ) {
      throw new Error("The recovery checkpoint belongs to another workspace.");
    }
  }

  return harnessTaskRuntime.start({
    runId,
    taskId: request?.taskId || "",
    clientId,
    detached,
    recoveryContext,
    metadata: {
      assistantId: request?.assistantId,
      sourceUserId: request?.sourceUserId,
      prompt: request?.prompt,
      workspacePath: request?.workspacePath,
      providerId: request?.providerId,
      modelId: request?.modelId,
    },
    onEvent,
    execute: ({ signal, control, emit, requestApproval }) =>
      runHarness({
        ...request,
        provider,
        memoryDirectory: join(app.getPath("userData"), "project-memory"),
        understandingDirectory: getProjectUnderstandingDirectory(),
        recoveryContext,
        signal,
        control,
        onEvent: emit,
        requestApproval,
      }),
  });
}

ipcMain.handle("desktop:minimize", (event) => {
  assertTrustedSender(event);
  mainWindow?.minimize();
  return true;
});

ipcMain.handle("desktop:toggle-maximize", (event) => {
  assertTrustedSender(event);
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
  return Boolean(mainWindow?.isMaximized());
});

ipcMain.handle("desktop:close", (event) => {
  assertTrustedSender(event);
  mainWindow?.close();
  return true;
});

ipcMain.handle("desktop:is-maximized", (event) => {
  assertTrustedSender(event);
  return Boolean(mainWindow?.isMaximized());
});

ipcMain.handle("desktop:set-theme", (event, theme) => {
  assertTrustedSender(event);
  return applyWindowTheme(theme);
});

ipcMain.handle("desktop:task-completed", (event, payload) => {
  assertTrustedSender(event);
  return notifyTaskCompleted(payload);
});

ipcMain.handle("desktop:select-directory", async (event) => {
  assertTrustedSender(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 Agent 工作区",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle("desktop:open-workspace", async (event, workspacePath) => {
  assertTrustedSender(event);
  if (
    typeof workspacePath !== "string" ||
    !workspacePath.trim() ||
    workspacePath.includes("\0")
  ) {
    throw new Error("A valid workspace directory is required.");
  }
  const verifiedPath = await realpath(resolve(workspacePath));
  const stats = await lstat(verifiedPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("The workspace must be a real directory.");
  }
  const openError = await shell.openPath(verifiedPath);
  if (openError) throw new Error(openError);
  return true;
});

ipcMain.handle("tasks:load", async (event) => {
  assertTrustedSender(event);
  return loadTasks();
});

ipcMain.handle("tasks:save", async (event, tasks) => {
  assertTrustedSender(event);
  await saveTasks(tasks);
  return true;
});

ipcMain.handle(
  "workspace:list-tree",
  async (event, workspacePath, requestedDirectory = ".") => {
    assertTrustedSender(event);
    return listWorkspaceTree(workspacePath, requestedDirectory);
  },
);

ipcMain.handle(
  "workspace:read-preview",
  async (event, workspacePath, requestedPath) => {
    assertTrustedSender(event);
    return readWorkspacePreview(workspacePath, requestedPath);
  },
);

ipcMain.handle("workspace:save-text", async (event, request) => {
  assertTrustedSender(event);
  return saveWorkspaceTextFile(request);
});

ipcMain.handle("workspace:revert", async (event, request) => {
  assertTrustedSender(event);
  return revertWorkspaceChanges(request);
});

ipcMain.handle("workspace:restore-anchor", async (event, request) => {
  assertTrustedSender(event);
  return restoreWorkspaceAnchor(request);
});

ipcMain.handle("understanding:get", async (event, workspacePath) => {
  assertTrustedSender(event);
  return (await openProjectUnderstanding(workspacePath)).snapshot();
});

ipcMain.handle("understanding:revert", async (event, request) => {
  assertTrustedSender(event);
  const store = await openProjectUnderstanding(request?.workspacePath);
  return store.revertTo(request?.revisionId, {
    taskId: request?.taskId,
  });
});

ipcMain.handle("attachments:parse", async (event, request) => {
  assertTrustedSender(event);
  return parseAttachment(request);
});

ipcMain.handle("providers:list", async (event) => {
  assertTrustedSender(event);
  return [
    publicAporiaCloudProvider(),
    ...(await loadProviderRecords()).map(publicProviderSummary),
  ];
});

ipcMain.handle("providers:discover", async (event, request) => {
  assertTrustedSender(event);
  if (request?.id === APORIA_CLOUD_PROVIDER_ID) {
    throw new Error("Aporia Cloud 模型目录由 Aporia Account 管理，无需手动发现。");
  }
  let apiKey = String(request?.apiKey || "").trim();
  if (!apiKey && request?.id) {
    const existing = (await loadProviderRecords()).find(
      (provider) => provider.id === request.id,
    );
    if (existing) apiKey = decryptProviderKey(existing);
  }
  return discoverProviderModels({
    baseUrl: request?.baseUrl,
    apiKey,
  });
});

ipcMain.handle("providers:save", async (event, request) => {
  assertTrustedSender(event);
  return saveProvider(request);
});

ipcMain.handle("providers:remove", async (event, providerId) => {
  assertTrustedSender(event);
  return removeProvider(providerId);
});

ipcMain.handle("sandbox:status", async (event) => {
  assertTrustedSender(event);
  return getSandboxStatus();
});

ipcMain.handle("sandbox:prepare", async (event) => {
  assertTrustedSender(event);
  return prepareSandbox({
    dataDirectory: app.getPath("userData"),
  });
});

ipcMain.handle("harness:has-api-key", async (event) => {
  assertTrustedSender(event);
  if ((await loadProviderRecords()).length > 0) return true;
  const account = await getDesktopAccountRuntime().getSnapshot().catch(() => null);
  return account?.status === "authenticated";
});

ipcMain.handle("harness:save-api-key", async (event, apiKey) => {
  assertTrustedSender(event);
  await saveApiKey(apiKey);
  return true;
});

ipcMain.handle("harness:clear-api-key", async (event) => {
  assertTrustedSender(event);
  await rm(getCredentialPath(), { force: true });
  await removeProvider("deepseek");
  return true;
});

ipcMain.handle("harness:run", async (event, request) => {
  assertTrustedSender(event);
  const runId = typeof request?.runId === "string" ? request.runId : "";
  return startHarnessTask(request, {
    clientId: String(event.sender.id),
    onEvent: (payload) => sendHarnessEvent(event, runId, payload),
  });
});

ipcMain.handle("harness:interrupt", (event, runId) => {
  assertTrustedSender(event);
  return harnessTaskRuntime.interrupt(runId, {
    clientId: String(event.sender.id),
  });
});

ipcMain.handle("harness:pause", async (event, runId) => {
  assertTrustedSender(event);
  return harnessTaskRuntime.pause(runId, {
    clientId: String(event.sender.id),
  });
});

ipcMain.handle("harness:resume", async (event, runId) => {
  assertTrustedSender(event);
  return harnessTaskRuntime.resume(runId, {
    clientId: String(event.sender.id),
  });
});

ipcMain.handle("harness:steer", (event, { runId, message }) => {
  assertTrustedSender(event);
  return harnessTaskRuntime.steer(runId, message, {
    clientId: String(event.sender.id),
  });
});

ipcMain.handle(
  "harness:approval-response",
  (event, { runId, approvalId, approved, scope = "once" }) => {
    assertTrustedSender(event);
    return harnessTaskRuntime.respondApproval(runId, approvalId, {
      approved,
      scope,
      clientId: String(event.sender.id),
    });
  },
);

ipcMain.handle("harness:active-runs", (event) => {
  assertTrustedSender(event);
  return harnessTaskRuntime.listActiveRuns();
});

ipcMain.handle("harness:recoverable-runs", async (event) => {
  assertTrustedSender(event);
  return harnessTaskRuntime.listRecoverableRuns();
});

ipcMain.handle(
  "harness:acknowledge-recovery",
  async (event, runId) => {
    assertTrustedSender(event);
    return harnessTaskRuntime.acknowledgeRecovery(runId);
  },
);

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  if (process.platform === "win32") {
    app.setAppUserModelId("com.aporiax.desktop");
  }
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !harnessTaskRuntime.hasActiveRuns()) {
    app.quit();
  }
});

export { harnessTaskRuntime, startHarnessTask };

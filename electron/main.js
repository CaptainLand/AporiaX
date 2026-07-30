import {
  BrowserWindow,
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
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listWorkspaceTree,
  readWorkspacePreview,
  revertWorkspaceChanges,
  runHarness,
  saveWorkspaceTextFile,
} from "./agent-runtime.js";
import { parseAttachment } from "./attachment-parser.js";
import {
  DEFAULT_DEEPSEEK_PROVIDER,
  discoverProviderModels,
  normalizeProviderInput,
  publicProviderSummary,
} from "./provider-config.js";
import {
  getSandboxStatus,
  prepareSandbox,
} from "./sandbox-runtime.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(currentDirectory, "..");
const isDevelopment = process.argv.includes("--dev");

let mainWindow = null;
const activeRuns = new Map();
const pendingApprovals = new Map();

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

async function resolveProvider(providerId) {
  const providers = await loadProviderRecords();
  const selected =
    providers.find((provider) => provider.id === providerId) ||
    providers[0];
  if (!selected) {
    throw new Error("尚未配置模型 API，请先添加一个 Provider。");
  }
  return {
    ...publicProviderSummary(selected),
    apiKey: decryptProviderKey(selected),
  };
}

async function saveProvider(input) {
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
  if (event.sender.isDestroyed()) return;
  event.sender.send("harness:event", { runId, ...payload });
}

function requestHarnessApproval(event, runId, details, signal) {
  if (signal.aborted) return Promise.resolve({ approved: false });
  const approvalId = randomUUID();

  return new Promise((resolveApproval) => {
    const handleAbort = () => {
      pendingApprovals.delete(approvalId);
      resolveApproval({ approved: false, interrupted: true });
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    pendingApprovals.set(approvalId, {
      runId,
      senderId: event.sender.id,
      resolve: (response) => {
        signal.removeEventListener("abort", handleAbort);
        resolveApproval(response);
      },
    });
    sendHarnessEvent(event, runId, {
      type: "approval.required",
      approval: {
        id: approvalId,
        ...details,
      },
    });
  });
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
  mainWindow.webContents.on("did-finish-load", sendWindowState);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.on("closed", () => {
    for (const run of activeRuns.values()) {
      run.controller.abort();
    }
    activeRuns.clear();
    mainWindow = null;
  });

  if (isDevelopment) {
    void mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    void mainWindow.loadFile(join(projectRoot, "dist", "index.html"));
  }
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

ipcMain.handle("workspace:list-tree", async (event, workspacePath) => {
  assertTrustedSender(event);
  return listWorkspaceTree(workspacePath);
});

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

ipcMain.handle("attachments:parse", async (event, request) => {
  assertTrustedSender(event);
  return parseAttachment(request);
});

ipcMain.handle("providers:list", async (event) => {
  assertTrustedSender(event);
  return (await loadProviderRecords()).map(publicProviderSummary);
});

ipcMain.handle("providers:discover", async (event, request) => {
  assertTrustedSender(event);
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
  return (await loadProviderRecords()).length > 0;
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
  const runId =
    typeof request?.runId === "string" ? request.runId : "";
  if (!runId || runId.length > 100) {
    throw new Error("A valid run id is required.");
  }
  if (activeRuns.has(runId)) {
    throw new Error("This Harness run is already active.");
  }
  const provider = await resolveProvider(request?.providerId);

  const controller = new AbortController();
  activeRuns.set(runId, {
    controller,
    senderId: event.sender.id,
  });

  try {
    return await runHarness({
      ...request,
      provider,
      signal: controller.signal,
      onEvent: (payload) => sendHarnessEvent(event, runId, payload),
      requestApproval: (details) =>
        requestHarnessApproval(
          event,
          runId,
          details,
          controller.signal,
        ),
    });
  } finally {
    activeRuns.delete(runId);
    for (const [approvalId, approval] of pendingApprovals) {
      if (approval.runId !== runId) continue;
      pendingApprovals.delete(approvalId);
      approval.resolve({ approved: false, interrupted: true });
    }
  }
});

ipcMain.handle("harness:interrupt", (event, runId) => {
  assertTrustedSender(event);
  const run = activeRuns.get(runId);
  if (!run || run.senderId !== event.sender.id) return false;
  run.controller.abort();
  return true;
});

ipcMain.handle(
  "harness:approval-response",
  (event, { runId, approvalId, approved }) => {
    assertTrustedSender(event);
    const approval = pendingApprovals.get(approvalId);
    if (
      !approval ||
      approval.runId !== runId ||
      approval.senderId !== event.sender.id
    ) {
      return false;
    }
    pendingApprovals.delete(approvalId);
    approval.resolve({ approved: Boolean(approved) });
    return true;
  },
);

ipcMain.handle("harness:active-runs", (event) => {
  assertTrustedSender(event);
  return [...activeRuns.keys()];
});

app.whenReady().then(() => {
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

const { contextBridge, ipcRenderer } = require("electron");

const taskExecutionModes = new Map();
let taskRevision;
let durableTaskIds = new Set();
let taskSaveTail = Promise.resolve();
let historyReadOnly = true;

const normalizeExecutionMode = (value) =>
  ["direct", "safe", "isolated"].includes(value) ? value : "safe";
const rememberTaskExecutionModes = (tasks) => {
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task?.id) continue;
    taskExecutionModes.set(task.id, normalizeExecutionMode(task.executionMode));
  }
  return tasks;
};

contextBridge.exposeInMainWorld("desktop", {
  isElectron: true,
  sideChat: {
    request: (input) => ipcRenderer.invoke("side-chat:request", input),
    subscribe: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on("side-chat:event", listener);
      return () => ipcRenderer.removeListener("side-chat:event", listener);
    },
  },
  workbench: {
    request: (input) => ipcRenderer.invoke("workbench:request", input),
    subscribe: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on("workbench:event", listener);
      return () => ipcRenderer.removeListener("workbench:event", listener);
    },
  },
  links: { activate: (request) => ipcRenderer.invoke("desktop:link", request) },
  selectDirectory: () => ipcRenderer.invoke("desktop:select-directory"),
  openWorkspace: (workspacePath) =>
    ipcRenderer.invoke("desktop:open-workspace", workspacePath),
  theme: {
    set: (theme) => ipcRenderer.invoke("desktop:set-theme", theme),
  },
  account: {
    get: () => ipcRenderer.invoke("account:get"),
    signIn: () => ipcRenderer.invoke("account:sign-in"),
    refresh: () => ipcRenderer.invoke("account:refresh"),
    signOut: () => ipcRenderer.invoke("account:sign-out"),
    setRemoteEnabled: (enabled) =>
      ipcRenderer.invoke("account:set-remote-enabled", enabled),
    setRemoteFileAccess: (enabled) =>
      ipcRenderer.invoke("account:set-remote-file-access", enabled),
    syncTasks: (payload) => ipcRenderer.invoke("account:sync-tasks", payload),
    remoteCommands: () => ipcRenderer.invoke("account:remote-commands"),
    claimRemoteCommand: (commandId) => ipcRenderer.invoke("account:claim-remote-command", commandId),
    acknowledgeRemoteCommand: (commandId, status, result = "", claim) =>
      ipcRenderer.invoke("account:ack-remote-command", commandId, status, result, claim),
    executeRemoteFileCommand: (command) =>
      ipcRenderer.invoke("account:execute-remote-file-command", command),
  },
  tasks: {
    load: async () => {
      await taskSaveTail.catch(() => {});
      const snapshot = await ipcRenderer.invoke("tasks:snapshot");
      taskRevision = snapshot.revision;
      historyReadOnly = snapshot.readOnly === true;
      durableTaskIds = new Set((snapshot.tasks || []).map((task) => task.id));
      return rememberTaskExecutionModes(snapshot.tasks);
    },
    diagnostics: () => ipcRenderer.invoke("tasks:diagnostics"),
    save: (tasks) => {
      rememberTaskExecutionModes(tasks);
      const snapshot = structuredClone(tasks);
      const operation = taskSaveTail.catch(() => {}).then(async () => {
        if (historyReadOnly || taskRevision === undefined) throw new Error("TASK_STORE_RECOVERY_REQUIRED: load history successfully before saving.");
        const ids = new Set(snapshot.map((task) => task.id));
        const result = await ipcRenderer.invoke("tasks:save", { tasks: snapshot, expectedRevision: taskRevision,
          deletedTaskIds: [...durableTaskIds].filter((id) => !ids.has(id)) });
        if (Number.isSafeInteger(result.revision)) taskRevision = result.revision;
        if (result.ok) durableTaskIds = ids;
        else for (const id of result.saved || []) durableTaskIds.add(id);
        return result;
      });
      taskSaveTail = operation;
      return operation;
    },
  },
  workspace: {
    listTree: (workspacePath, requestedDirectory = ".") =>
      ipcRenderer.invoke(
        "workspace:list-tree",
        workspacePath,
        requestedDirectory,
      ),
    readPreview: (workspacePath, requestedPath) =>
      ipcRenderer.invoke(
        "workspace:read-preview",
        workspacePath,
        requestedPath,
      ),
    saveText: (request) =>
      ipcRenderer.invoke("workspace:save-text", request),
    revert: (request) => ipcRenderer.invoke("workspace:revert", request),
    restoreAnchor: (request) =>
      ipcRenderer.invoke("workspace:restore-anchor", request),
  },
  understanding: {
    setSettings: (request) => ipcRenderer.invoke("understanding:settings", request),
    get: (workspacePath) =>
      ipcRenderer.invoke("understanding:get", workspacePath),
    revert: (request) =>
      ipcRenderer.invoke("understanding:revert", request),
  },
  attachments: {
    parse: (request) => ipcRenderer.invoke("attachments:parse", request),
    store: (request) => ipcRenderer.invoke("attachments:store", request),
  },
  ocr: { request: (input) => ipcRenderer.invoke("ocr:request", input) },
  providers: {
    list: () => ipcRenderer.invoke("providers:list"),
    discover: (request) =>
      ipcRenderer.invoke("providers:discover", request),
    save: (request) => ipcRenderer.invoke("providers:save", request),
    remove: (providerId) =>
      ipcRenderer.invoke("providers:remove", providerId),
  },
  sandbox: {
    status: () => ipcRenderer.invoke("sandbox:status"),
    prepare: () => ipcRenderer.invoke("sandbox:prepare"),
    openRecovery: () => ipcRenderer.invoke("sandbox:open-recovery"),
  },
  core: {
    status: () => ipcRenderer.invoke("core:status"),
    capabilities: (request = {}) =>
      ipcRenderer.invoke("core:capabilities", request),
    agents: () => ipcRenderer.invoke("core:agents"),
    plugins: () => ipcRenderer.invoke("core:plugins"),
    skills: (request = {}) => ipcRenderer.invoke("core:skills", request),
    mcp: (request = {}) => ipcRenderer.invoke("core:mcp", request),
    library: (request = {}) => ipcRenderer.invoke("core:library", request),
    searchOnlineExtensions: (request) => ipcRenderer.invoke("core:library:search-online", request),
    onlineExtensionDetails: (request) => ipcRenderer.invoke("core:library:online-details", request),
    installOnlineSkill: (request) => ipcRenderer.invoke("core:library:install-online-skill", request),
    verifyLibrarySkill: (request) => ipcRenderer.invoke("core:library:verify-skill", request),
    installLibrarySkill: (request) =>
      ipcRenderer.invoke("core:library:install-skill", request),
    importLibrarySkill: () =>
      ipcRenderer.invoke("core:library:import-skill"),
    rollbackLibrarySkill: (request) => ipcRenderer.invoke("core:library:rollback-skill", request),
    toggleLibraryMcp: (request) => ipcRenderer.invoke("core:library:toggle-mcp", request),
    probeLibraryMcp: (request) => ipcRenderer.invoke("core:library:probe-mcp", request),
    removeLibrarySkill: (request) =>
      ipcRenderer.invoke("core:library:remove-skill", request),
    saveLibraryMcp: (request) =>
      ipcRenderer.invoke("core:library:save-mcp", request),
    importLibraryMcp: () =>
      ipcRenderer.invoke("core:library:import-mcp"),
    removeLibraryMcp: (request) =>
      ipcRenderer.invoke("core:library:remove-mcp", request),
    extensionPolicy: (request = {}) =>
      ipcRenderer.invoke("core:extension-policy", request),
    setExtensionPolicy: (request) =>
      ipcRenderer.invoke("core:set-extension-policy", request),
    sessions: () => ipcRenderer.invoke("core:sessions"),
    events: (request = {}) => ipcRenderer.invoke("core:events", request),
  },
  update: {
    status: () => ipcRenderer.invoke("update:status"),
    check: (request = {}) => ipcRenderer.invoke("update:check", request),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    openRelease: () => ipcRenderer.invoke("update:open-release"),
    subscribe: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on("update:event", listener);
      return () => ipcRenderer.removeListener("update:event", listener);
    },
  },
  notifications: {
    taskCompleted: (payload) =>
      ipcRenderer.invoke("desktop:task-completed", payload),
    onTaskRequested: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("desktop:task-requested", handler);
      return () => {
        ipcRenderer.removeListener("desktop:task-requested", handler);
      };
    },
  },
  window: {
    minimize: () => ipcRenderer.invoke("desktop:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("desktop:toggle-maximize"),
    close: () => ipcRenderer.invoke("desktop:close"),
    isMaximized: () => ipcRenderer.invoke("desktop:is-maximized"),
    onMaximizedChange: (listener) => {
      const handler = (_event, isMaximized) => listener(isMaximized);
      ipcRenderer.on("desktop:window-state", handler);
      return () => {
        ipcRenderer.removeListener("desktop:window-state", handler);
      };
    },
  },
  harness: {
    hasApiKey: () => ipcRenderer.invoke("harness:has-api-key"),
    saveApiKey: (apiKey) =>
      ipcRenderer.invoke("harness:save-api-key", apiKey),
    clearApiKey: () => ipcRenderer.invoke("harness:clear-api-key"),
    run: (request) =>
      ipcRenderer.invoke("harness:run", {
        ...request,
        executionMode: normalizeExecutionMode(
          request?.executionMode || taskExecutionModes.get(request?.taskId),
        ),
      }),
    interrupt: (runId) =>
      ipcRenderer.invoke("harness:interrupt", runId),
    pause: (runId) => ipcRenderer.invoke("harness:pause", runId),
    resume: (runId) => ipcRenderer.invoke("harness:resume", runId),
    steer: (request) => ipcRenderer.invoke("harness:steer", request),
    activeRuns: () => ipcRenderer.invoke("harness:active-runs"),
    recoverableRuns: () =>
      ipcRenderer.invoke("harness:recoverable-runs"),
    acknowledgeRecovery: (runId) =>
      ipcRenderer.invoke("harness:acknowledge-recovery", runId),
    respondToApproval: (response) =>
      ipcRenderer.invoke("harness:approval-response", response),
    onEvent: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("harness:event", handler);
      return () => {
        ipcRenderer.removeListener("harness:event", handler);
      };
    },
  },
});

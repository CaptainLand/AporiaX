const { contextBridge, ipcRenderer } = require("electron");

const taskExecutionModes = new Map();
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
  },
  tasks: {
    load: () =>
      ipcRenderer.invoke("tasks:load").then((tasks) => rememberTaskExecutionModes(tasks)),
    save: (tasks) => {
      rememberTaskExecutionModes(tasks);
      return ipcRenderer.invoke("tasks:save", tasks);
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
    get: (workspacePath) =>
      ipcRenderer.invoke("understanding:get", workspacePath),
    revert: (request) =>
      ipcRenderer.invoke("understanding:revert", request),
  },
  attachments: {
    parse: (request) => ipcRenderer.invoke("attachments:parse", request),
  },
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
    installLibrarySkill: (request) =>
      ipcRenderer.invoke("core:library:install-skill", request),
    importLibrarySkill: () =>
      ipcRenderer.invoke("core:library:import-skill"),
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

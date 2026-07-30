const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isElectron: true,
  selectDirectory: () => ipcRenderer.invoke("desktop:select-directory"),
  openWorkspace: (workspacePath) =>
    ipcRenderer.invoke("desktop:open-workspace", workspacePath),
  theme: {
    set: (theme) => ipcRenderer.invoke("desktop:set-theme", theme),
  },
  tasks: {
    load: () => ipcRenderer.invoke("tasks:load"),
    save: (tasks) => ipcRenderer.invoke("tasks:save", tasks),
  },
  workspace: {
    listTree: (workspacePath) =>
      ipcRenderer.invoke("workspace:list-tree", workspacePath),
    readPreview: (workspacePath, requestedPath) =>
      ipcRenderer.invoke(
        "workspace:read-preview",
        workspacePath,
        requestedPath,
      ),
    saveText: (request) =>
      ipcRenderer.invoke("workspace:save-text", request),
    revert: (request) => ipcRenderer.invoke("workspace:revert", request),
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
    run: (request) => ipcRenderer.invoke("harness:run", request),
    interrupt: (runId) =>
      ipcRenderer.invoke("harness:interrupt", runId),
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

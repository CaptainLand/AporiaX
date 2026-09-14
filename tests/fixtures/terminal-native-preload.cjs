const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("nativeTerminalTask", JSON.parse(process.env.TERMINAL_TEST_TASK));
contextBridge.exposeInMainWorld("desktop", { workbench: {
  request: (input) => ipcRenderer.invoke("terminal-test:request", input),
  subscribe(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("workbench:event", listener);
    return () => ipcRenderer.removeListener("workbench:event", listener);
  },
} });

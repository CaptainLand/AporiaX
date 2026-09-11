const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("approvalToast", {
  decide: (approved) => ipcRenderer.send("approval-toast:decide", Boolean(approved)),
  onPayload: (listener) => {
    ipcRenderer.on("approval-toast:payload", (_event, payload) => listener(payload));
  },
});

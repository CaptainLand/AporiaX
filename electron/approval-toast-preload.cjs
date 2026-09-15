const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("approvalToast", {
  decide: (approved) => {
    if (typeof approved !== "boolean") throw new TypeError("Approval must be a boolean.");
    ipcRenderer.send("approval-toast:decide", approved);
  },
  onPayload: (listener) => {
    ipcRenderer.on("approval-toast:payload", (_event, payload) => listener(payload));
  },
});

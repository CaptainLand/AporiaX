const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("approvalToast", {
  decide: (approved, scope = 'once') => {
    if (typeof approved !== "boolean") throw new TypeError("Approval must be a boolean.");
    if (!['once', 'run'].includes(scope) || (!approved && scope === 'run')) throw new TypeError('Invalid approval scope.');
    ipcRenderer.send("approval-toast:decide", approved, scope);
  },
  onPayload: (listener) => {
    ipcRenderer.on("approval-toast:payload", (_event, payload) => listener(payload));
  },
});

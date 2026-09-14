const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdtemp } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
let service, win;
app.whenReady().then(async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "aporiax-terminal-ui-"));
  const task = { id: "native-terminal-ui", workspacePath };
  process.env.TERMINAL_TEST_TASK = JSON.stringify(task);
  const { createWorkbenchService } = await import(pathToFileURL(join(__dirname, "../../electron/workbench/service.js")));
  win = new BrowserWindow({ show: false, width: 1200, height: 850,
    webPreferences: { preload: join(__dirname, "terminal-native-preload.cjs"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  service = createWorkbenchService({ getWindow: () => win });
  ipcMain.handle("terminal-test:request", (event, input) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Untrusted test sender");
    return service.request(input);
  });
  ipcMain.handle("terminal-test:close", async () => { await service.closeAll(); return true; });
  await win.loadURL(process.env.TERMINAL_TEST_URL);
}).catch((error) => { console.error(error); app.exit(1); });
app.on("before-quit", () => { void service?.closeAll(); });

const { app, BrowserWindow, Menu, dialog, shell, clipboard } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

app.whenReady().then(async () => {
  let root;
  let window;
  try {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "aporia-links-"));
    const source = path.join(root, "示例.txt");
    const output = path.join(root, "副本.txt");
    const executable = path.join(root, "test.exe");
    await fs.writeFile(source, "link test");
    await fs.writeFile(executable, "not a real executable");
    window = new BrowserWindow({ show: false });
    const { handleDesktopLink } = await import(pathToFileURL(path.resolve("electron/desktop-links.js")));
    const event = { sender: window.webContents };
    const opened = [], copied = [], revealed = [];
    let selection = "";
    let labels = [];
    let response = 0;
    let confirmations = 0;
    shell.openPath = async (p) => { opened.push(p); return ""; };
    shell.openExternal = async (p) => { opened.push(p); };
    shell.showItemInFolder = (p) => { revealed.push(p); };
    clipboard.writeText = (p) => { copied.push(p); };
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    dialog.showMessageBox = async () => { confirmations++; return { response }; };
    Menu.buildFromTemplate = (items) => {
      labels = items.map((item) => item.label).filter(Boolean);
      return { popup({ callback }) { items.find((item) => item.label === selection)?.click(); callback(); } };
    };
    const request = { href: source, workspacePath: root, language: "zh-CN", action: "menu" };
    selection = "复制路径";
    assert.equal((await handleDesktopLink(event, request)).ok, true);
    assert.equal(copied[0], source);
    assert.ok(labels.includes("另存为…"));
    assert.ok(labels.includes("在其他应用 / IDE 中打开…"));
    selection = "另存为…";
    await handleDesktopLink(event, request);
    assert.equal(await fs.readFile(output, "utf8"), "link test");
    selection = "在文件夹中显示";
    await handleDesktopLink(event, request);
    assert.equal(revealed[0], source);
    await handleDesktopLink(event, { ...request, href: executable, action: "open" });
    assert.equal(confirmations, 1);
    assert.equal(opened.length, 0, "executable blocked when confirmation declined");
    response = 1;
    await handleDesktopLink(event, { ...request, href: executable, action: "open" });
    assert.equal(opened[0], executable);
    selection = "在其他应用 / IDE 中打开…";
    await handleDesktopLink(event, request); // Canceling picker must do nothing.
    selection = "Copy link";
    await handleDesktopLink(event, { href: "https://example.com", language: "en", action: "menu" });
    assert.equal(copied.at(-1), "https://example.com/");
    await assert.rejects(handleDesktopLink(event, { href: "javascript:alert(1)" }), /Unsupported|不支持/);
    await assert.rejects(handleDesktopLink(event, { href: path.join(root, "missing.txt") }), /不存在|does not exist/);
    assert.equal((await handleDesktopLink(event, { ...request, action: "check" })).status, "exists");
    assert.equal((await handleDesktopLink(event, { ...request, href: "missing.txt", action: "check" })).status, "missing");
    const unicodeName = "SeaLandX-B站用户资料简介-美化版.docx";
    await fs.writeFile(path.join(root, unicodeName), "link test");
    await handleDesktopLink(event, { ...request, href: unicodeName, action: "open" });
    assert.equal(opened.at(-1), path.join(root, unicodeName));
    const percentName = "报告 #1 %20 100% 🚀.txt";
    await fs.writeFile(path.join(root, percentName), "encoded only once");
    await handleDesktopLink(event, { ...request, href: encodeURIComponent(percentName), action: "open" });
    assert.equal(opened.at(-1), path.join(root, percentName));
    await assert.rejects(handleDesktopLink(event, { href: "C:/test.txt:hidden" }), /Invalid|无效/);
    console.log("Electron native link handlers (OS effects mocked, save copied on disk): PASS");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    if (root) await fs.rm(root, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});

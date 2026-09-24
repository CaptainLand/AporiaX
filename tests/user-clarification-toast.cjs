const { app, BrowserWindow, screen, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let directory;
app.on('window-all-closed', () => {});
(async () => {
  directory = await mkdtemp(join(tmpdir(), 'aporia-clarification-toast-'));
  app.setPath('userData', directory);
  await app.whenReady();
  const { showClarificationToast, closeClarificationToast, showApprovalToast, closeApprovalToast } =
    await import(pathToFileURL(join(__dirname, '../electron/approval-toast.js')).href);
  const question = { id: 'fixture', runId: 'run', taskId: 'task', question: '这份报告面向谁？内部报告与公开报告需要不同的内容。' };
  let opened = 0;
  const waitReady = async () => {
    for (let i = 0; i < 100; i++) {
      const window = BrowserWindow.getAllWindows()[0];
      if (window?.isVisible() && !window.webContents.isLoading()) return window;
      await delay(30);
    }
    assert.fail('Toast did not load');
  };
  showClarificationToast({ question, onOpen: () => opened++ });
  let window = await waitReady();
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("approve").textContent'), '去回答');
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("deny").textContent'), '稍后');
  const bounds = window.getBounds(), area = screen.getPrimaryDisplay().workArea;
  assert.equal(bounds.x + bounds.width, area.x + area.width - 24);
  assert.equal(bounds.y + bounds.height, area.y + area.height - 24);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".toast").getBoundingClientRect().right <= innerWidth'), true, 'Toast must not be clipped');
  await mkdir(join(__dirname, '../.tmp/user-clarification'), { recursive: true });
  await writeFile(join(__dirname, '../.tmp/user-clarification/toast.png'), (await window.webContents.capturePage()).toPNG());
  ipcMain.emit('approval-toast:decide', { sender: {} }, true);
  assert.equal(opened, 0, 'An unrelated renderer cannot open or decide this request');
  await window.webContents.executeJavaScript('document.getElementById("deny").click()');
  await delay(30); assert.equal(opened, 0); assert.equal(BrowserWindow.getAllWindows().length, 0);
  showClarificationToast({ question, onOpen: () => opened++ });
  window = await waitReady();
  await window.webContents.executeJavaScript('document.getElementById("approve").click()');
  await delay(30); assert.equal(opened, 1);
  showClarificationToast({ question, onOpen: () => opened++ });
  await waitReady();
  closeClarificationToast('other-run'); assert.equal(BrowserWindow.getAllWindows().length, 1);
  closeClarificationToast('run'); await delay(30); assert.equal(BrowserWindow.getAllWindows().length, 0);
  let approved = false;
  showApprovalToast({ approval: { id: 'approval', title: '确认命令' }, onDecide: value => { approved = value; } });
  window = await waitReady();
  closeClarificationToast(); assert.equal(window.isDestroyed(), false, 'Question cleanup cannot close an approval');
  await window.webContents.executeJavaScript('document.getElementById("approve").click()');
  await delay(30); assert.equal(approved, true);
  // A reminder timeout must not produce any decision.
  let timedOutDecision = false;
  showApprovalToast({ approval: {}, timeoutMs: 100, onDecide: () => { timedOutDecision = true; } });
  await delay(250); assert.equal(timedOutDecision, false);
  closeApprovalToast();
  await writeFile(join(__dirname, '../.tmp/user-clarification/toast-result.json'), JSON.stringify({ passed: true, opened, approved }));
  console.log('PASS Electron: real bottom-right toast, sender guard, later/open, task-scoped close, approval regression, passive timeout');
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  await writeFile(join(__dirname, '../.tmp/user-clarification/toast-result.json'), JSON.stringify({ passed: false, error: error.stack }));
}).finally(async () => {
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  app.exit(process.exitCode || 0);
});

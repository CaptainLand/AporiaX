let configuration = null;
export function configureTrustedIpc(options) { configuration = options; }
export function isTrustedAppUrl(value, expectedUrl, development = false) {
  try {
    const actual = new URL(value), expected = new URL(expectedUrl);
    if (actual.username || actual.password) return false;
    if (development) return actual.origin === expected.origin && ['/', '/index.html'].includes(actual.pathname);
    return actual.protocol === 'file:' && actual.host === expected.host && actual.pathname === expected.pathname && !actual.search;
  } catch { return false; }
}
export function assertTrustedIpcSender(event) {
  const window = configuration?.getWindow();
  const sender = window?.webContents;
  if (!sender || window.isDestroyed() || event?.sender !== sender || !event.senderFrame ||
      event.senderFrame !== sender.mainFrame ||
      !isTrustedAppUrl(event.senderFrame.url, configuration.expectedUrl, configuration.development))
    throw new Error('Rejected IPC request from an untrusted frame or application origin.');
}
export function handleTrustedIpc(ipcMain, channel, listener) {
  return ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event);
    return listener(event, ...args);
  });
}

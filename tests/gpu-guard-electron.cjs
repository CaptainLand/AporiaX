const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

// A separate profile and hidden window: never alter the running installation.
const profile = mkdtempSync(join(tmpdir(), 'aporiax-gpu-guard-test-'));
app.setPath('userData', profile);
const legacyFlag = join(profile, 'gpu-fallback.json');
const originalFlag = JSON.stringify({ crashes: 9, disableHardwareAcceleration: true, reason: 'killed', at: Date.now() });
writeFileSync(legacyFlag, originalFlag);
const cache = join(profile, 'GPUCache');
mkdirSync(cache);
const sentinel = join(cache, 'guard-test-sentinel.txt');
writeFileSync(sentinel, 'must-not-delete');
let disabledCalls = 0;
const originalDisable = app.disableHardwareAcceleration;
app.disableHardwareAcceleration = () => { disabledCalls++; };
const deadline = setTimeout(() => { console.error('GPU guard startup test timed out'); app.exit(1); }, 20000);
let window;
(async () => {
  await import(pathToFileURL(resolve('electron/gpu-guard.js')).href);
  assert.equal(disabledCalls, 0, 'legacy flag must not disable acceleration at startup');
  app.disableHardwareAcceleration = originalDisable;
  await app.whenReady();
  const accelerationBefore = app.isHardwareAccelerationEnabled();
  window = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<title>GPU guard isolated check</title><canvas></canvas>');
  // Synthetic notifications do not kill any real GPU process.
  for (const reason of ['killed', 'clean-exit', 'crashed', 'oom']) {
    for (let count = 0; count < 5; count++) app.emit('child-process-gone', {}, { type: 'GPU', reason, exitCode: 1 });
  }
  assert.equal(app.isHardwareAccelerationEnabled(), accelerationBefore, 'guard must not change acceleration policy');
  assert.equal(readFileSync(legacyFlag, 'utf8'), originalFlag, 'legacy diagnostic remains untouched');
  assert.equal(readFileSync(sentinel, 'utf8'), 'must-not-delete', 'guard does not clear GPU caches');
  console.log('PASS isolated Electron: legacy disable flag ignored; process exits cannot change acceleration or rewrite state; cache preserved. Hardware acceleration enabled: ' + accelerationBefore);
})().then(() => {
  clearTimeout(deadline);
  window?.destroy();
  app.exit(0);
}).catch(error => {
  clearTimeout(deadline);
  console.error(error);
  app.exit(1);
});

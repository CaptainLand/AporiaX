# AporiaX Desktop Background v1

Desktop Background v1 keeps active Harness work alive when the desktop window is closed from the title bar and removes the redundant in-app task-completion toast.

## Behavior

On Windows/Linux desktop builds:

- Minimize behaves normally.
- Clicking the AporiaX close button hides the main BrowserWindow instead of destroying it.
- The Electron main process, renderer, active `harness:run` IPC calls, Main/Builder/Review/Verify work, and run journals remain alive.
- A system tray icon remains available while the window is hidden.
- Clicking or double-clicking the tray icon restores AporiaX.
- The tray menu shows the number of active Harness runs.
- `打开 AporiaX` restores the desktop window.
- `退出 AporiaX` is the explicit real-exit path. It marks the app as quitting and calls `app.quit()`; the compatibility main process then closes the window and aborts active runs using its existing shutdown cleanup.

The implementation is installed from `main-v2.js` before `main.js` creates its BrowserWindow. This intentionally avoids rewriting the proven compatibility main process: a pre-installed `browser-window-created` listener intercepts the window `close` event and calls `preventDefault()` + `hide()` unless an explicit app quit is in progress.

## Completion notifications

The Windows/Electron system notification remains the canonical task-completion notification. Clicking it still restores AporiaX and focuses the completed task through the existing `desktop:task-requested` path.

The renderer's existing `.task-completion-toast` is suppressed with Electron `webContents.insertCSS()` after the main page loads. This removes the duplicate AporiaX-internal completion popup without changing approval prompts, errors, task history, completion state, or the system-notification call path.

The renderer state is deliberately left intact for compatibility; only the redundant completion toast is removed from presentation.

## Background run tracking

`main-v2.js` already wraps `harness:run` to install the Adaptive Agent Budget. Desktop Background v1 extends that same wrapper with a run-id set:

```text
harness:run starts
      |
      +--> tray active-run count +1
      |
      +--> Agent Budget / Harness execution
      |
      +--> finally: tray active-run count -1
```

This means the tray status reflects both ordinary Main-only runs and orchestrated Main + Builder runs without reaching into the private `activeRuns` map in `main.js`.

## Intentional boundaries

This is a desktop-shell background mode, not yet a detached Core service:

- The Electron process must remain running.
- Explicit `退出 AporiaX`, OS process termination, shutdown, or machine sleep can stop work.
- The renderer remains alive while hidden because the current Harness IPC lifecycle still belongs to Desktop (`taskRpc:false`).
- A later Core-service stage can move task ownership out of the desktop process and survive a full UI process exit/restart.

## Validation

Run:

```text
npm run test:desktop-background
npm run test:collaboration
npm run test:harness-v2
npm run test:architecture
npm run test:cache
npm run test:runtime
npm run build
npm start
```

Then manually verify on Windows:

1. Start a task that runs long enough to observe.
2. Click the title-bar close button. The window should disappear while the tray icon remains and the task continues.
3. Open the tray menu and confirm it reports the active run count.
4. Click the tray icon or `打开 AporiaX`; the same task should still be active.
5. Hide AporiaX again and let the task finish. Windows should show the existing system completion notification.
6. Reopen AporiaX. The old in-app `任务完成 / Task completed` toast should not appear.
7. Start another task, choose tray `退出 AporiaX`, and confirm the application actually exits rather than hiding again.

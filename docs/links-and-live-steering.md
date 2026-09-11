# Desktop file links and live steering

## Behavior

- Markdown file links support Windows paths, file URLs, workspace-relative paths, spaces, Chinese filenames and :line / #Lline suffixes.
- Click opens a file using its system association. Right-click (or Shift+F10) provides Open, Save as, Show in folder, Open in another app / IDE, Copy path, and Copy name. Directories omit Save as. Web links open externally and offer Copy link.
- The native menu follows the application language. The app/IDE chooser selects an executable; Code, Cursor and Windsurf use --goto when a line is present. This first version does not embed previews or persist an IDE preference.
- Executables, scripts and unrecognized file types require confirmation before system opening. Unknown URL schemes, network/device paths and Windows alternate data streams are rejected. Missing-file failures are displayed next to the link. Save as uses the native destination/overwrite dialog; the original file cannot be selected as its own copy destination.
- These local file actions do not enable remote file access or cloud uploads.

## Live guidance

- During main-model generation, guidance cancels only the inference request, not the task. Public partial output is retained, never private reasoning or incomplete tool calls. A new request includes the guidance.
- Started tools finish normally. Tools in a batch that have not started are skipped with explicit tool receipts, then the model replans. Parallel tools already running may therefore still take time.
- The stable live assistant/run identity retains Witness, Anchor and completion routing. Visible pre-guidance output is archived before the user's message; post-guidance output follows it. Buffered deltas are flushed before splitting.
- Guidance is recorded in the run journal and checkpoint for recovery. Provider-reported usage received before cancellation is retained; cancellation does not refund provider charges, and providers may omit usage when disconnected early.
- This does not forcibly cancel ongoing subagent work, approvals or finalization steps. It cannot insert text into an already-running inference without making a replacement request.

## Verification

Run `npm run test:links-steering` on Windows. Browser tests use a fresh headless Edge profile (override executable with TEST_BROWSER). No user login or paid model requests are used.

- Parser/safety, stable message IDs, multi-guidance ordering and cancellation unit tests.
- Actual main agent loop + persistent task runtime with mock provider streams: cancel a long response; preserve an in-flight read; skip the pending write; verify new guidance in the next request and recovery records.
- Actual React conversation and Harness event hook in a browser: click/right-click callbacks, relative workspace context, visible errors and buffered-delta chronology.
- Electron native menu handlers: bilingual entries, real temporary-file Save as, executable confirm/cancel. System opening, clipboard and native dialog choices are mocked so tests do not launch programs or change the user's clipboard. Interactive IDE launch is not automated.

Existing priority-one, provider stream, task RPC, turn coordinator, message reducer/hook, runtime UI, retry and streaming performance tests are also run. The streaming test no longer requires unrelated effects to be adjacent; its ref-refresh and 750ms debounce assertions remain.

Local source and frontend build only; previously packaged release executables are not replaced by these changes.

# Changelog

## 0.5.0 — 2026-08-10

AporiaX 0.5.0 is a major Harness milestone focused on adaptive multi-agent execution, conflict-safe parallel building, collaboration contracts, and a more practical Windows desktop lifecycle.

### Harness architecture

- Added a shared Event Bus and Hook API for runtime and extension events.
- Added declarative Agent definitions and built-in Explore, Review, Verify, Curator, and Builder roles.
- Split the Harness into clearer Session, Scheduler, Context, Agent, Tool, Review, Plugin, Kernel, and Core boundaries while preserving compatibility with the proven runtime path.
- Added Plugin API and a loopback-only authenticated Core Server foundation.

### Adaptive execution and Builder orchestration

- Added Adaptive Agent Budget so simple tasks remain Main-only while more complex tasks can receive bounded additional Agents.
- Added real Builder orchestration for eligible large write tasks, with a hard maximum of two Builders.
- Added Task Graph scheduling, Scope Leases, isolated Git worktrees, dirty-workspace overlay handling, and conflict-checked merge back into the real workspace.
- Builder workers cannot broaden their write scope, execute arbitrary commands, or recursively delegate Agents.
- Concurrent Main/user edits reject unsafe Builder merges instead of being overwritten.

### Multi-Agent collaboration

- Added Shared Collaboration Contracts for cross-Builder UI, API, schema, state, security, and acceptance invariants.
- Added deterministic Plan Approval before parallel Builder work begins.
- Added structured Builder handoffs, contract assertions, and semantic disagreement detection.
- Added a bounded mailbox for questions, notices, and blockers without unrestricted live peer chat.
- Main remains the final integration authority; Witness remains observational.

### Review, verification, and project understanding

- Preserved progressive version-matched Review and Verify flows around the compatibility runtime.
- Added stronger mandatory self-check behavior and verification evidence handling.
- Kept DeepSeek cache-hit/cache-miss accounting and stable conversation-prefix behavior.
- Integrated collaboration context with Review, Verify, Curator, and Witness auditing.

### Desktop experience

- Closing the main window now hides AporiaX to the Windows system tray instead of terminating active work.
- Active Harness tasks continue while the window is hidden and can be restored from the tray.
- Added an explicit tray Exit action for a real application shutdown.
- Windows system completion notifications remain the canonical completion notice; the duplicate in-app completion toast is suppressed.
- Added task elapsed-time display in the conversation UI and live elapsed runtime in tray status.
- Added a one-time first-close notification explaining that AporiaX was moved to the tray and work continues in the background.

### 0.5.0 stabilization fixes

- Updated Harness v2 smoke fixtures to the Collaboration v1 Shared Contract / Plan Approval rules.
- Fixed Adaptive Agent Budget intent classification for short explicit Explore requests and background exploration.
- Added Chinese `创建` write-intent recognition.
- Added `self-check` / `自检` / `复核` / `校验` verification intent recognition so quality pipelines receive sufficient budget.
- Added explicit durable Remember / `记住` intent handling for automatic Curator flows.

### Validation

The 0.5.0 release candidate passed the Windows release gate:

- desktop background smoke
- collaboration smoke
- Harness v2 smoke
- Harness v2 orchestration smoke
- Harness architecture smoke
- DeepSeek cache smoke
- full Runtime smoke
- Vite production build
- Electron startup and manual desktop/tray lifecycle checks

### Known boundaries

- Core HTTP task RPC is still disabled; credentials, approvals, pause/resume, and mutation control remain in the desktop runtime.
- Close-to-tray keeps the Electron process alive; active tasks do not yet survive a full process exit/restart.
- Read-only legacy subagent execution still uses compatibility-runtime internals in some paths.
- Collaboration intentionally does not provide unrestricted live peer-to-peer Agent chat.

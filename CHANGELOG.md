# Changelog

## 0.6.1 — 2026-08-12

AporiaX 0.6.1 upgrades the native Agent toolchain and makes user-managed Skills and MCP servers practical from the desktop UI.

### Agent-native file and code tools

- Added paged `read_file` reads with line ranges, character offsets, continuation metadata, total size information, and SHA-256 preconditions for safe follow-up edits.
- Replaced recursive literal-only search with bundled ripgrep, including literal, regular-expression, symbol, heuristic definition/reference modes, and include/exclude globs. A portable Node fallback remains available.
- Upgraded `apply_patch` to accept preflighted multi-hunk, multi-file unified diffs with create/delete support, dry runs, optimistic SHA-256 checks, atomic rollback, and per-file change evidence.
- Added task-scoped persistent terminal processes: start a server/watcher/REPL, incrementally read logs, write stdin, and stop the full process tree. Processes are bounded and automatically cleaned up at task end.

### Approval and extensions

- Added read-only access to a specific file outside the workspace through `read_external_file`. Every invocation requires a fresh user approval and never grants external write access.
- Added native folder import for user Skills, including package validation, symlink rejection, bounded size/file counts, and atomic installation.
- Added MCP JSON import for AporiaX and common `mcpServers` configuration shapes.
- Extended the composer `@` menu to discover files, `@skill:<name>`, and `@mcp:<id>`. Explicit MCP mentions scope a run to the named configured servers.
- Added bilingual import controls and activity presentation for the new tools.

### Validation

- Added focused smoke coverage for ranged reads, ripgrep modes/globs, multi-file and delete patches, external-read approval policy, Skill/MCP import, MCP mentions, and interactive persistent processes.
- Added retry-transaction coverage for stale-run reconciliation, replacement acceptance, rejected starts, and visible renderer errors.
- Verified the production renderer build after the toolchain and Extensions Center changes.

### Desktop reliability and polish

- Reworked stopped-turn retry into one observable transaction and fixed the detached attachment classifier that could make the retry button appear inert.
- Added more first-party Skill presets and bilingual extension discovery/import presentation.
- Reduced welcome-screen particle cost with adaptive sampling, visibility pausing, and a 120 FPS cap.
- Added a local account and weekly-quota UI prototype without server or password persistence.

## 0.6.0 — 2026-08-11

AporiaX 0.6.0 is a major architecture release. It replaces accumulated renderer and runtime bridges with explicit state, lifecycle, capability, extension, review, and execution boundaries while adding a substantially broader local Agent platform.

### Architecture reconstruction

- Rebuilt the conversation surface as native React UI and removed the legacy DOM enhancement islands.
- Added a single-source TaskStore, pure Harness event reducers, and an explicit run/turn lifecycle coordinator so task state, streaming updates, retries, stops, and recovery share one authority.
- Extracted provider streaming, tool permissions, native tool dispatch/execution, workspace safety, conversation normalization, subagent loops, self-check evidence, and progressive review coordination into testable runtime modules.
- Batched streaming deltas and deferred persistence outside the hot path to reduce renderer churn on long responses.
- Added an architecture freeze gate that prevents retired state bridges and migration-era compatibility paths from silently returning.

### Unified capabilities, Skills, MCP, and Browser

- Added a unified Harness capability registry for native tools, Skills, MCP tools, Browser tools, Office generation, and extension-provided capabilities.
- Added a bilingual Extensions center with discover, install/configure, enable/disable, source-policy, and permission presentation for Skills and MCP servers.
- Added a built-in extension library and first-party Skill templates for frontend review and release readiness.
- Added declarative Skill discovery and per-run activation with workspace isolation and bounded instruction loading.
- Added trusted local and remote MCP server configuration with scoped tool exposure and explicit approval boundaries.
- Added an isolated Playwright Browser runtime with observable actions and separate interaction permissions.
- Added vision-proxy routing and native/proxied vision capability feedback for image attachments.

### Multi-Agent execution and quality

- Preserved Adaptive Agent Budget and conflict-safe Builder orchestration while moving their tools through the unified dispatcher and capability model.
- Made progressive Review and Verify work version-aware so stale findings and stale verification evidence cannot seal newer file contents.
- Allowed up to two bounded self-check workers for eligible preflight review without blocking Main Agent progress unnecessarily.
- Added stronger final-seal evidence rules, per-file review tracking, and current-version verification requirements.
- Added autonomous Curator decisions for Project Understanding: durable architecture, conventions, commands, preferences, and debugging knowledge are proposed only when the task produced reusable evidence.

### Witness, recovery, and task isolation

- Made Witness a persistent, observable record of Main/subagent progress instead of a disappearing transient status line.
- Added slow-command warnings and bounded intervention for commands that stop making progress, including process-tree cleanup and strategy-adjustment evidence.
- Strengthened turn and task isolation so a greeting or new task cannot silently resume unrelated unfinished work from another conversation.
- Fixed stopped-run recovery and retry cleanup so stale run state no longer leaves an unusable recovery card behind.
- Kept Anchor rollback versioned and conflict-checked across turns.

### Sandbox and desktop experience

- Commands now run automatically in a temporary local workspace sandbox when Docker is unavailable; Docker remains an optional stronger offline, read-only-root isolation layer.
- Added conflict-checked synchronization, sensitive-environment filtering, bounded command length/runtime, and workspace-only working-directory enforcement.
- Added stable live Agent status, workspace file mentions, long-prompt folding, task duration, tray background execution, and Windows completion notifications.
- Extended task settings and renderer capability feedback without hard-coding a single model provider.

### Validation

The 0.6.0 release gate covers the production renderer build and focused smoke suites for runtime behavior, task state, turn coordination, streaming, permissions, sandbox and Witness watchdogs, Browser, MCP, Skills, extension lifecycle policy, Understanding automation, progressive self-check, capability observability, and the v0.6 architecture freeze.

### Known boundaries

- Windows x64 remains the packaged desktop target for this preview release.
- Docker sandbox networking is intentionally disabled; dependency downloads should use the local sandbox or a separately approved workflow.
- Scanned PDFs are detected as requiring OCR, but an OCR engine is not bundled yet.
- Third-party Skills and MCP servers remain trusted extensions and should be reviewed before enabling.

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

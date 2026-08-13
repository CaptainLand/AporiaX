# Changelog

## 0.7.1 — 2026-08-14

AporiaX 0.7.1 improves Harness performance and reliability while keeping high-risk verification strict.

- Added role-aware low-compute defaults for Explore, Verify, and Understanding Curator; Review can retain deeper parent reasoning.
- Made self-check escalation risk-aware instead of relying on file count alone.
- Deferred Project Understanding curation until the main result is ready and skipped low-value turns.
- Prevented provider retries after streamed output begins, avoiding duplicated or corrupted responses.
- Switched the default Desktop account authorization entry from the legacy GitHub Pages site to the current AporiaX Web deployment.
- Added focused regression coverage and refreshed Windows x64 installer, portable package, checksums, bilingual README, and bilingual release notes.

## 0.7.0 — 2026-08-13

AporiaX 0.7.0 introduces the first complete Aporia Account + Aporia Cloud desktop path while keeping the existing local-first Harness, BYOK providers, and local model workflows intact.

### Aporia Account and Desktop authorization

- Added native browser sign-in with PKCE S256, exact state validation, and a loopback callback on `127.0.0.1`.
- Access Tokens remain inside Electron Main memory and are not exposed to renderer/provider configuration.
- Refresh Tokens are encrypted with Electron `safeStorage`, rotated through the Cloud refresh flow, and cleared on invalid sessions/sign-out.
- Account hydration now covers identity, rolling weekly quota, Cloud model catalog, usage summary, and bound Desktop device state.
- Account sign-in does not upload local workspaces, project source, or local conversation history.

### Aporia Cloud managed models

- Added first-party `Aporia Cloud` as a managed model source beside user providers and local models.
- Added managed **DeepSeek V4 Flash** as the default Cloud model.
- Added managed **DeepSeek V4 Pro** as a second selectable Cloud model.
- Cloud traffic uses the authenticated Aporia Model Gateway rather than a user-supplied DeepSeek API key.
- BYOK and local providers remain independent; weekly-quota exhaustion does not silently fall back to a paid user API.
- Added stable source/billing metadata and dedicated Desktop smoke coverage for managed Cloud routing.

### Cloud Vision

- Added first-party image understanding for Aporia Cloud through hidden Qwen3.5 Flash Vision routing while DeepSeek remains the main Agent model.
- Explicit image attachments are materialized before the Harness loop into compact textual observations.
- Raw image attachments are removed after materialization so later tool rounds do not repeatedly resend/rebill the same image.
- Multiple images are analyzed independently.
- Qwen credentials/provider URLs remain Cloud-side and are never bundled into Desktop.

### Privacy-preserving free-tier identity

- Added one persistent random Desktop installation UUID under Electron `userData` for free-tier anti-abuse coordination.
- The identifier survives sign-out/session rotation and is sent only during native Desktop token exchange.
- No hardware serials, MAC addresses, MachineGuid, disk IDs, or similar hardware fingerprints are read for this mechanism.
- Cloud stores only the HMAC-hashed installation identity.

### Production-test polish

- Simplified model rows to source-specific labels for Aporia Cloud, Your API, and Local.
- Removed redundant capability copy such as `No API key required`, `Tool use`, `Vision`, and `Text only` from model cards.
- Stopped presenting local/offline models as automatically image-capable.
- Stabilized model-row widths so Flash / Pro / BYOK entries use the same full-width layout.
- Completed blue progress journals remain compact by default but now expand to the complete retained progress history with one click and no arbitrary pixel-height cap.
- Cloud connectivity failures no longer fill the lower-left account area with repeated red network errors.
- Preserved the production-test additions for bounded external read-only references and built-in Word / Spreadsheet / Presentation design skills.

### Release metadata and validation

- Updated Desktop package version to `0.7.0`.
- Node.js `>=22.12.0` remains the source requirement.
- Windows x64 remains the packaged target.
- Account, Cloud model, vision, runtime, execution, permission, LSP, GitHub workflow, and production renderer checks remain part of the release validation path.

### Known boundaries

- Aporia Cloud features require a reachable Cloud deployment; BYOK/local providers remain usable independently.
- Local/offline image understanding requires a user-configured visual model/runtime and is not automatic.
- Scanned PDFs are detected as requiring OCR, but an OCR engine is not bundled yet.
- Windows 0.7.0 installer/portable binaries are published separately from the source/version presentation update.

## 0.6.5 — 2026-08-12

AporiaX 0.6.5 strengthens the Coding Agent runtime around explicit execution boundaries, deterministic permissions, persistent language intelligence, and end-to-end Git/GitHub workflows.

### Execution and Smart Permission

- Added explicit **Direct / Safe / Isolated** execution profiles and kept execution location separate from permission decisions.
- Direct operates on the authorized workspace with host process/network authority.
- Safe runs against a temporary workspace copy and synchronizes changes back only after conflict checks.
- Isolated requires the Docker sandbox and never silently falls back to Host when selected.
- Added deterministic Smart Permission classification for low-, medium-, high-, and critical-risk command patterns.
- Low-risk Git inspection and bounded build/test/lint/type-check workflows can run automatically; dependency mutation, explicit network access, remote writes, and destructive workspace operations remain approval-gated.
- Clearly system-destructive command patterns are denied at the policy boundary.
- Explicit tool-level `ask` policies cannot be bypassed merely because a sandbox backend exists.

### Persistent LSP and managed language servers

- Added a persistent native LSP runtime with `status`, `diagnostics`, `definition`, `references`, `hover`, `document_symbols`, and `workspace_symbols`.
- Bundled TypeScript / JavaScript language intelligence.
- Added approval-gated `lsp_install` for supported missing language servers.
- Python can install Pyright into AporiaX-managed storage.
- Go can install gopls into AporiaX-managed storage.
- Rust can resolve/install rust-analyzer through rustup.
- C/C++ can install clangd through winget on Windows, Homebrew on macOS, or apt-get on Linux.
- `lsp status` now exposes availability, source, installer, and managed-install state so the Agent can recover from missing language tooling without sending the user to manual setup instructions.

### Native Git / GitHub workflow

- Added `git_init` so a normal project folder can be initialized by the Agent instead of requiring the user to run Git manually first.
- Added native `git_stage`, `git_commit`, `git_create_branch`, `git_remote_list`, `git_remote_add`, `git_pull`, and `git_push` workflows.
- Added `github_repo_create`, `github_pr_create`, `github_pr_view`, and `github_pr_checks`.
- Local Git lifecycle operations can run autonomously under workspace-write policy, while remote routing and writes remain explicit approval boundaries.
- Staging requires explicit workspace-relative paths; commits use staged changes only.
- Pull requires a clean working tree and defaults to fast-forward-only behavior.
- Force push is intentionally not exposed.
- GitHub credentials remain inside the authenticated GitHub CLI process and are not serialized into model context.

### Release metadata and validation

- Updated the package version to `0.6.5` and Node.js engine requirement to `>=22.12.0`.
- Added focused smoke coverage for execution policy/wiring, LSP runtime, LSP installation, GitHub workflow, tool permissions, and tool dispatch.
- The integrated 0.6.5 pull request passed the full validation matrix and production renderer build before merge.

### Known boundaries

- Windows x64 remains the packaged desktop target for this preview release.
- Safe protects workspace mutations but still has host process/network authority; Isolated is the stronger OS-level boundary.
- Persistent Host processes are supported in Direct/Safe. Isolated intentionally blocks silent Host fallback until persistent isolated-process support is implemented.
- Workspace Trust and more granular secret/environment policies remain follow-up work.
- Scanned PDFs are detected as requiring OCR, but an OCR engine is not bundled yet.

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

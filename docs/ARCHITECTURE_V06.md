# AporiaX v0.6 Architecture Consolidation

AporiaX v0.6 is an incremental architecture consolidation, not a rewrite. The goal is to preserve current product behavior while replacing the duplicated renderer/runtime paths that made small changes expensive and fragile.

## Core invariants

1. **One live renderer truth** — TaskStore owns live task state.
2. **Persistence is not state** — desktop JSON is durable storage; localStorage is a debounced startup cache only.
3. **Native React message UI** — elapsed time, Live Agent Status, process trace, prompt folding, Witness and streamed Markdown receive the same message object.
4. **No DOM reverse lookup for application state** — renderer logic no longer discovers tasks/messages through MutationObserver/index matching.
5. **One Harness event boundary** — renderer protocol handling enters through `useHarnessEvents()`.
6. **Runtime modules own stable boundaries** — Provider streaming, tool permissions/dispatch, workspace safety, native execution, self-check and subagents no longer live as one monolithic implementation.
7. **Capabilities share one registry** — Native, Browser, Plugin, Skill and MCP metadata enter the Harness Capability Registry.
8. **Safety follows the execution boundary** — sandboxed workspace commands can auto-run; unsafe host/external side effects remain approval-gated.
9. **Behavior before movement** — focused tests plus broad runtime/Harness/build gates protect each extraction.

## Renderer architecture

```text
Harness events
     ↓
useHarnessEvents()
     ↓
TaskStore ───────────────→ desktop checkpoint
     │
     ├─ ConversationViews
     │    ├─ RunDuration
     │    ├─ LiveAgentStatus
     │    ├─ streaming Markdown
     │    ├─ meaningful Agent Process
     │    └─ Witness
     ├─ Composer
     │    └─ @workspace autocomplete
     ├─ RouteView
     └─ Settings
          ├─ Vision / Skill task capabilities
          └─ Extensions Center
```

Successful turns no longer retain generic `Run completed` presentation or bookkeeping-only process steps. Compact process UI is for concrete files, commands, changes, specific plan steps, subagent work and attention states.

## Runtime architecture

```text
runHarness()
   │
   ├─ Provider Stream
   ├─ Conversation Runtime
   ├─ Tool Catalog
   ├─ Tool Dispatcher / Permissions
   │       ↓
   │   Native Tool Executor
   │       ↓
   │   Workspace Runtime / Sandbox / Browser / Office
   │
   ├─ Self-check Coordinator
   │       ├─ Self-check Evidence
   │       └─ Subagent Loop
   │              └─ Subagent Model / Scope
   │
   └─ Harness event/result coordination
```

Current runtime modules:

```text
electron/runtime/
├─ provider-stream.js
├─ conversation.js
├─ native-tool-catalog.js
├─ tool-permissions.js
├─ tool-dispatcher.js
├─ native-tool-executor.js
├─ workspace-runtime.js
├─ self-check-evidence.js
├─ self-check-coordinator.js
├─ subagent-model.js
└─ subagent-loop.js
```

The remaining `agent-runtime-core.js` is increasingly coordination code rather than the implementation home for every subsystem.

## Sandbox and approval semantics

```text
workspace-write + sandbox-auto + safe Docker/local sandbox
    → workspace file writes allowed
    → run_command auto-runs inside the safe boundary

manual command mode
    → approval

no safe sandbox
    → host command requires approval

Builder isolated worktree
    → file edits + relevant build/test/lint/typecheck allowed

Browser state-changing controls
    → approval

MCP side-effecting tools
    → approval

read-only task
    → remains read-only
```

Repository configuration may make permissions stricter but cannot elevate the UI-selected policy.

`run_command.reason` is optional. A missing cosmetic explanation no longer rejects a valid command; the approval layer supplies a safe fallback explanation when approval is needed.

## Unified Capability Registry

```text
Native ──┐
Browser ─┤
Plugin ──┼─→ Harness Capability Registry
Skill ───┤
MCP ─────┘
```

A capability records public metadata such as kind, source, name/title, risk, scope, provider/plugin/server id and observability tags.

MCP capabilities are **run scoped**. Tool/resource/prompt metadata is registered after MCP discovery and removed when that MCP runtime closes. Tokens, headers, resource bodies, prompt results and tool results are not stored in the capability catalog.

The catalog is available through:

```text
kernel.capabilitiesRegistry
kernel.snapshot()
window.desktop.core.capabilities(...)
GET /v1/capabilities
```

Application Settings now includes an **Extensions** section backed by this registry. It surfaces capability counts, Skills, trusted/configured MCP servers and loaded plugins without turning a project into an implicit executable-install trust boundary.

## Migration status

### Phase 1 — State and Conversation

- [x] TaskStore live state and persistence boundary.
- [x] Native React runtime-message UI.
- [x] Remove DOM/index/localStorage renderer bridges.
- [x] Native `@workspace` autocomplete.
- [x] Native Vision/Skill capability cards.
- [x] Streaming performance batching and debounced local cache.

### Phase 2 — Renderer modules

- [x] Move Conversation/Composer/Route/Settings out of `main.jsx`.
- [x] Move model catalog/common controls out of `main.jsx`.
- [x] Extract Harness event subscription into `useHarnessEvents()`.
- [ ] Convert selected high-value event branches into pure reducer helpers where it materially simplifies tests.
- [ ] Continue shrinking app-level modal/shell orchestration when useful; no rewrite target is required.

### Phase 3 — Runtime modules

- [x] Provider streaming/retry/SSE.
- [x] Conversation normalization.
- [x] Native Tool catalog/risk metadata.
- [x] Tool permission/approval decisions.
- [x] Native Tool dispatcher.
- [x] Native Tool executor.
- [x] Workspace realpath/search/Git safety runtime.
- [x] Self-check evidence model.
- [x] Progressive SelfCheckCoordinator.
- [x] Subagent scope/evidence model.
- [x] Actual subagent model/tool loop.
- [x] Preserve public compatibility exports and Harness event shapes.
- [ ] Further reduce the remaining `runHarness()` body only when a new stable coordination boundary is identifiable.

### Phase 4 — Unified capability layer

- [x] Add Harness Capability Registry.
- [x] Bridge Native/Browser/Plugin ToolHost registrations.
- [x] Publish discovered Skills as scoped capability metadata.
- [x] Publish per-run MCP tools/resources/prompts and clean them up on close.
- [x] Expose capability catalog through Core/IPC.
- [x] Build Extensions settings surface from the unified registry.
- [ ] Derive more Route/Witness labels and UI metadata from capability metadata instead of feature-specific maps.
- [ ] Add safe enable/disable/edit flows on top of Extensions Center where the underlying trust model supports them.

## Validation strategy

The v0.6 stack now has focused regressions for:

```text
TaskStore / renderer architecture
streaming performance
Provider streaming
Tool permissions
Tool dispatcher
Self-check evidence/coordinator
Subagent model/loop
Native Tool executor
Workspace runtime
Conversation runtime
Native Tool catalog
Capability Registry
Scoped MCP capabilities
Extensions Center
```

Each architecture PR also runs a relevant subset of the broader runtime, Harness v2, Browser/MCP and Vite build checks before its generated extraction is committed.

## Non-goals

- rewrite AporiaX from scratch
- move the local Agent runtime to a server
- remove local-first/BYOK support
- make Browser/MCP external side effects silently auto-approved
- use the Capability Registry as a cache for secret or large external data

The v0.6 consolidation succeeds when the next capability can be added through explicit runtime/capability boundaries instead of touching five unrelated state and rendering paths merely to become usable and observable.

# AporiaX v0.6 Architecture Consolidation

AporiaX v0.6 is an incremental architecture consolidation, not a rewrite. Its architecture-debt phase is now considered **frozen**: future Browser, Computer Use, MCP, Plugin, Skill and cloud work should extend the boundaries below instead of reopening the old duplicated renderer/runtime paths.

## Frozen invariants

1. **One live renderer truth** — TaskStore owns live task state.
2. **Persistence is not state** — desktop JSON is durable storage; localStorage is only a debounced startup cache.
3. **Native React message UI** — elapsed time, Live Agent Status, process trace, prompt folding, Witness and streamed Markdown consume the same message object.
4. **No DOM reverse lookup for application state** — no MutationObserver/index matching is used to discover the current task/message.
5. **One renderer protocol boundary** — Harness events enter through `useHarnessEvents()`; high-frequency deterministic task transforms live in the pure Harness event reducer.
6. **Explicit run lifecycle** — `TurnCoordinator` owns round/phase/terminal lifecycle while domain modules own model, tool, self-check and subagent behavior.
7. **Runtime modules own stable boundaries** — Provider streaming, conversation, tool catalog/permission/dispatch/execution, workspace safety, self-check and subagents are separate modules.
8. **Capabilities share one registry** — Native, Browser, Plugin, Skill and MCP publish public metadata through the Harness Capability Registry.
9. **Observable UI follows capability metadata** — Route/Witness prefer capability presentation metadata; hardcoded renderer maps are compatibility fallback for old persisted history.
10. **Extension availability is not permission** — Extension Policy can remove optional sources from availability but can never elevate Tool Permission or Approval.
11. **Project policy can only tighten** — `.aporiax/extensions.json` may disable Browser/Plugin/Skill/MCP sources but cannot re-enable a source disabled by the user.
12. **Safety follows the execution boundary** — sandboxed workspace commands may auto-run; host/external side effects remain approval-gated.

## Renderer

```text
Harness events
      ↓
useHarnessEvents()
      ├─ side effects / streaming buffer / approval UI
      ↓
Pure Harness Event Reducer
      ↓
TaskStore ───────────────→ durable desktop checkpoint
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
           ├─ Vision / Skill task capability cards
           └─ Extensions Center
```

Successful turns do not keep bookkeeping-only `Run completed` / generic process rows. Compact process UI is reserved for concrete files, commands, changes, specific plan steps, subagent work and attention states.

## Runtime

```text
runHarness()
    ↓
TurnCoordinator
    ├─ round / phase / terminal lifecycle
    ├─ control boundary
    └─ model-response classification
         │
         ├─ Provider Stream
         ├─ Conversation Runtime
         ├─ Tool Catalog
         ├─ Tool Dispatcher / Permissions
         │      ↓
         │   Native Tool Executor
         │      ↓
         │   Workspace Runtime / Sandbox / Browser / Office
         ├─ SelfCheckCoordinator
         │      ├─ Self-check Evidence
         │      └─ Subagent Loop
         │             └─ Subagent Model / Scope
         └─ final result / Harness protocol
```

Runtime modules:

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
├─ subagent-loop.js
└─ turn-coordinator.js
```

`agent-runtime-core.js` remains the composition/orchestration layer. It should not become the implementation home for a new capability when an existing runtime/registry boundary can own it.

## Capability and extension layer

```text
Native ──┐
Browser ─┤
Plugin ──┼─→ Capability Registry ─→ presentation / observability
Skill ───┤              │
MCP ─────┘              ↓
                  Extension Policy
                         │
                         ↓
                availability filtering
                         │
                         ↓
                  Tool Permission
                         ↓
                     Approval
                         ↓
                     Executor
                         ↓
                     Witness
```

A capability stores public metadata only: kind/source/name/title/risk/scope/provider/plugin/server, observability tags and presentation metadata. MCP tool/resource/prompt capabilities are run-scoped and removed when the MCP runtime closes. Tokens, auth headers, resource bodies, prompt results and Tool results are never stored in the capability catalog.

### Extension Policy

User policy:

```text
<Electron userData>/aporiax-extensions.json
```

Managed optional sources:

```text
browser
plugin
skill
mcp
```

Native core capabilities are not disable-able through Extension Policy.

Project policy:

```text
<workspace>/.aporiax/extensions.json
```

may contain only a `disabled` list. Project configuration cannot enable a user-disabled source and cannot grant Tool permission.

The Extensions Center exposes safe user-level enable/disable switches. Enabling a source only makes already installed/configured/trusted capabilities eligible again. Browser control and side-effecting MCP calls still follow their existing Permission/Approval rules; MCP server commands remain governed by the user-level MCP trust file.

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

Repository configuration may make permissions stricter but cannot elevate the UI-selected policy. `run_command.reason` is optional; the approval layer supplies a safe fallback description when one is needed.

## Migration status

### Phase 1 — State and Conversation — COMPLETE

- [x] TaskStore live state and persistence boundary.
- [x] Native React runtime-message UI.
- [x] Remove DOM/index/localStorage renderer bridges.
- [x] Native `@workspace` autocomplete.
- [x] Native Vision/Skill capability cards.
- [x] Streaming performance batching and debounced local cache.

### Phase 2 — Renderer modules — COMPLETE

- [x] Move Conversation/Composer/Route/Settings out of `main.jsx`.
- [x] Move model catalog/common controls out of `main.jsx`.
- [x] Extract Harness event subscription into `useHarnessEvents()`.
- [x] Extract high-value deterministic task/message event transforms into a pure reducer.
- [x] Preserve side effects in the hook instead of mixing them into state reducers.

Further shell/modal decomposition is ordinary maintenance, not architecture debt.

### Phase 3 — Runtime modules — COMPLETE

- [x] Provider streaming/retry/SSE.
- [x] Conversation normalization.
- [x] Native Tool catalog/risk metadata.
- [x] Tool permission/approval decisions.
- [x] Native Tool dispatcher and executor.
- [x] Workspace realpath/search/Git safety runtime.
- [x] Self-check evidence model and progressive coordinator.
- [x] Subagent scope/evidence model and actual model/tool loop.
- [x] Explicit Run/Turn lifecycle coordinator.
- [x] Preserve public compatibility exports and existing Harness event shapes.

Further shrinking `runHarness()` is optional composition cleanup unless a new stable domain boundary appears.

### Phase 4 — Unified capability and extension layer — COMPLETE

- [x] Harness Capability Registry.
- [x] Native/Browser/Plugin ToolHost capability registrations.
- [x] Scoped Skill capability metadata.
- [x] Per-run MCP tools/resources/prompts with scope cleanup.
- [x] Core/IPC capability catalog.
- [x] Capability metadata drives current Route/Witness tool presentation with legacy fallback.
- [x] Extensions Center.
- [x] Safe Extension Policy lifecycle with user enable/disable and project-only tightening.

## Architecture freeze gate

`npm run test:v06-architecture` guards the module boundaries and prevents accidental return to the old renderer bridges or feature-prefix UI routing.

The final closeout regression set includes focused TaskStore/renderer, event reducer, streaming, runtime, Tool, Self-check, Subagent, Capability, MCP, Browser, Extension Policy and Vite build tests.

## What is feature work after the freeze

The following are **not** unfinished v0.6 architecture debt:

- Computer Use
- richer Browser automation
- MCP OAuth / editor / server marketplace
- Plugin installation and distribution UX
- Skill marketplace / sharing
- cloud accounts, billing and model gateway
- additional Provider/model integrations

Those should now enter through the frozen runtime, capability, policy and observability boundaries.

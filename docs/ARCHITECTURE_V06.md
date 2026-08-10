# AporiaX v0.6 Architecture Consolidation

AporiaX v0.6 is an incremental architecture consolidation. It is **not** a rewrite.

The goal is to preserve the current product behavior while removing the duplicated state paths and oversized module boundaries that made small UI/runtime changes expensive and fragile.

## Why now

The v0.5 feature stack grew quickly:

```text
Harness
├─ Adaptive Agent Budget
├─ Builder / Collaboration
├─ Witness / Route / Anchor
├─ Vision Proxy
├─ Skills
├─ Browser
└─ MCP
```

Before v0.6, several presentation features observed the same run through different paths:

```text
React task state
Desktop task JSON
localStorage cache
Harness event stream
MutationObserver / injected React roots
```

That duplication produced one class of failures repeatedly: the task itself continued correctly while elapsed time, live status, process UI, or capability cards became stale because a presentation bridge matched a cached message instead of the live React message.

Phase 1 removed that renderer split-brain state. Phase 2 is separating the remaining renderer modules and Harness event subscription. Phase 3 is now decomposing the oversized runtime without changing its protocol.

## v0.6 invariants

1. **One live task truth** — the in-memory TaskStore is the only live renderer state.
2. **Persistence is not state** — desktop JSON is durable storage; localStorage is only an optional startup cache.
3. **Message UI receives messages directly** — elapsed time, live status, process trace, prompt folding, Witness, and response streaming render from the same React message object.
4. **No DOM reverse lookup for application state** — MutationObserver is not used to discover which task/message/textarea is active.
5. **Harness events reduce into state once** — UI components do not independently reconstruct task state from DOM snapshots.
6. **Capabilities share one boundary** — Native, Browser, Plugin, and MCP tools eventually enter one capability/tool host before Permission → Approval → Witness.
7. **Behavior before movement** — tests lock existing behavior before code is moved out of `main.jsx` or `agent-runtime-core.js`.

## Renderer after Phase 2 extraction

```text
Harness event
    ↓
useHarnessEvents()
    ↓
TaskStore ───────────────→ desktop checkpoint
    │
    ├─ Sidebar
    ├─ ConversationViews
    │    ├─ UserMessage
    │    │    └─ FoldablePrompt
    │    └─ AssistantMessage
    │         ├─ RunDuration
    │         ├─ LiveAgentStatus
    │         ├─ Markdown stream
    │         ├─ AgentProcess
    │         └─ Witness
    ├─ Composer
    │    └─ WorkspaceMentionAutocomplete
    ├─ RouteView
    └─ SettingsPanel
         ├─ VisionCapability
         └─ SkillCapability
```

`index.html` boots one renderer entry (`main.jsx`). Runtime presentation no longer mounts secondary React roots into DOM produced by the main React tree.

## Current renderer source layout

```text
src/
├─ components/
│  └─ Controls.jsx
├─ composer/
│  ├─ Composer.jsx
│  └─ WorkspaceMentionAutocomplete.jsx
├─ conversation/
│  ├─ ConversationViews.jsx
│  └─ RuntimeMessageUI.jsx
├─ hooks/
│  └─ useHarnessEvents.js
├─ models/
│  └─ model-catalog.js
├─ settings/
│  ├─ SettingsPanel.jsx
│  └─ TaskCapabilityCards.jsx
└─ state/
   ├─ task-store-core.js
   └─ useTaskStore.js
```

`main.jsx` still owns the application shell, task commands, persistence coordination, and some app-level state. Those are the remaining renderer decomposition targets; the large Conversation/Composer/Route/Settings and Harness subscription blocks are no longer embedded in it.

## TaskStore contract

The TaskStore core is framework-light and React consumes it through `useSyncExternalStore`.

```text
createTaskStore(initial)
  getSnapshot()
  subscribe(listener)
  replace(tasks)
  update(mutator)
  updateTask(taskId, updater)
  updateMessage(taskId, messageId, updater)
  appendMessage(taskId, message)
```

Every committed mutation increments a revision and retains lightweight mutation metadata for diagnostics. `useTaskStore()` intentionally keeps a `useState`-compatible setter during migration, so existing `setTasks(current => ...)` call sites can move behind one store without a giant behavioral rewrite.

### Persistence policy

```text
startup
  local cache → fast initial paint
       ↓
desktop load completes
       ↓
TaskStore replaces startup cache
       ↓
TaskStore changes → debounced desktop save
       ↓
optional lightweight local cache
```

Once desktop loading succeeds, even an empty desktop task list is authoritative. Only a missing desktop store (`null`) can trigger one-time migration from the startup cache. A truncated localStorage cache never remaps live messages.

## Native Conversation UI

`src/conversation/RuntimeMessageUI.jsx` owns native React versions of:

- task elapsed-time chip
- Live Agent Status
- Agent Process trace
- long user-prompt folding

They consume the actual `message` object passed by `Conversation`. The old DOM/index/localStorage matching implementation has been removed from production.

`src/composer/WorkspaceMentionAutocomplete.jsx` keeps `@workspace/file` discovery and keyboard selection inside Composer React state.

`src/settings/TaskCapabilityCards.jsx` renders Vision and Skill state from the current task/provider/core APIs instead of appending cards to the Settings DOM from a secondary root.

## Harness event boundary

`src/hooks/useHarnessEvents.js` owns the renderer subscription to the Harness protocol. The first extraction preserves the existing event branches while removing the subscription from `App`.

It covers streaming deltas, plans, Witness, native/Browser/MCP tool state, Skills, subagents, Project Understanding, self-check, approvals, runtime control and final Route state.

Follow-up work may make individual transforms pure reducer functions, but the subscription boundary is now explicit and testable.

## Runtime migration

The runtime target remains:

```text
electron/runtime/
├─ run-loop.js
├─ provider-stream.js      ← extracted
├─ conversation.js
├─ tool-dispatcher.js
├─ approvals.js
├─ self-check.js
├─ subagents.js
└─ evidence.js
```

`electron/runtime/provider-stream.js` now owns OpenAI-compatible fetch/retry/SSE parsing, `response.delta`, reasoning accumulation, tool-call chunk assembly, usage capture, and Provider idle-timeout/abort mapping.

`agent-runtime-core.js` imports the same Provider factory contract, so the Harness event protocol and model loop remain backward compatible.

## Capability migration

The eventual tool path is:

```text
Native ─┐
Browser ├─→ Capability Registry → ToolHost → Permission → Approval → Witness
Plugin  ┤
MCP ────┘

Skill Registry → Agent context / recommended capabilities
```

A Skill remains declarative guidance and never grants capability permissions.

## Migration gates

### Phase 1 — State and Conversation

- [x] Add TaskStore core and persistence snapshot helpers.
- [x] Switch `App` task state to TaskStore through `useSyncExternalStore`.
- [x] Add native React runtime-message components.
- [x] Render duration / Live Agent Status / Agent Process / prompt folding directly from message props.
- [x] Remove duration/process/live-status/prompt-folding DOM bridge entries.
- [x] Move workspace mention autocomplete into Composer React state.
- [x] Move Vision/Skill capability cards into Settings React state.
- [x] Remove the remaining renderer DOM state bridges from the production entry.
- [x] Add architecture regression coverage for the single-entry native renderer.

### Phase 2 — Renderer modules

- [x] Move Conversation/Composer/Route/Settings out of `main.jsx`.
- [x] Move model catalog and common task controls out of `main.jsx`.
- [x] Extract Harness event subscription from `App` into a dedicated hook boundary.
- [ ] Convert high-value Harness event transforms into pure reducer helpers.
- [ ] Reduce `main.jsx` further toward app bootstrap/top-level composition.
- [ ] Add selector-level tests for active task/run/message state.

### Phase 3 — Runtime modules

- [x] Split Provider streaming/retry/SSE handling into `runtime/provider-stream.js`.
- [ ] Split the conversation/run loop coordination.
- [ ] Split tool dispatch / approval.
- [ ] Split self-check / evidence.
- [ ] Split subagent orchestration.
- [x] Keep Harness event shapes backward compatible while moving code.

### Phase 4 — Unified capability layer

- [ ] Register Native/Browser/Plugin/MCP capabilities through one adapter contract.
- [ ] Make Route/Witness labels derive from capability metadata instead of per-feature UI patches.
- [ ] Build the Extensions settings surface on top of the unified registry.

## Validation gates

Renderer consolidation is guarded by:

```text
npm run test:task-store
npm run test:runtime-ui
npm run test:process-ui
npm run test:renderer-architecture
npm run test:renderer-modules
npm run test:harness-events-ui
npm run test:skills
npm run test:architecture
npm run build
```

Provider-stream extraction additionally requires:

```text
npm run test:provider-stream
npm run test:runtime
npm run test:vision
npm run test:mcp
npm run test:browser
npm run test:harness-v2
```

Migration workflows commit generated refactors only after their relevant gates pass.

## Non-goals

- rewriting the application from scratch
- changing model behavior while moving UI state
- replacing the existing Harness or Builder design
- moving the local Agent runtime to a server
- removing local-first / BYOK support

The v0.6 refactor succeeds when adding the next capability no longer requires touching five unrelated state/rendering paths just to make it observable in the UI.

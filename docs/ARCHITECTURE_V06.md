# AporiaX v0.6 Architecture Consolidation

AporiaX v0.6 is an incremental architecture consolidation. It is **not** a rewrite.

The goal is to preserve the current product behavior while removing the duplicated state paths and DOM-patching bridges that made small UI/runtime changes expensive and fragile.

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

Phase 1 removes that renderer split-brain state.

## v0.6 invariants

1. **One live task truth** — the in-memory TaskStore is the only live renderer state.
2. **Persistence is not state** — desktop JSON is durable storage; localStorage is only an optional startup cache.
3. **Message UI receives messages directly** — elapsed time, live status, process trace, prompt folding, Witness, and response streaming render from the same React message object.
4. **No DOM reverse lookup for application state** — MutationObserver is not used to discover which task/message/textarea is active.
5. **Harness events reduce into state once** — UI components do not independently reconstruct task state from DOM snapshots.
6. **Capabilities share one boundary** — Native, Browser, Plugin, and MCP tools eventually enter one capability/tool host before Permission → Approval → Witness.
7. **Behavior before movement** — tests lock existing behavior before code is moved out of `main.jsx` or `agent-runtime-core.js`.

## Renderer after Phase 1

```text
Harness event
    ↓
App event reducer
    ↓
TaskStore ───────────────→ desktop checkpoint
    │
    ├─ Sidebar
    ├─ Conversation
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
    ├─ Route
    └─ Settings
         ├─ VisionCapability
         └─ SkillCapability
```

`index.html` boots one renderer entry (`main.jsx`). Runtime presentation no longer mounts secondary React roots into DOM produced by the main React tree.

## Target source layout

```text
src/
├─ app/
│  └─ App.jsx
├─ conversation/
│  ├─ Conversation.jsx
│  ├─ UserMessage.jsx
│  ├─ AssistantMessage.jsx
│  └─ RuntimeMessageUI.jsx
├─ composer/
│  ├─ Composer.jsx
│  └─ WorkspaceMentionAutocomplete.jsx
├─ route/
│  └─ RouteView.jsx
├─ settings/
│  ├─ SettingsPanel.jsx
│  └─ TaskCapabilityCards.jsx
├─ state/
│  ├─ task-store-core.js
│  ├─ useTaskStore.js
│  ├─ run-reducer.js
│  └─ selectors.js
└─ hooks/
   └─ useHarnessEvents.js
```

The directory structure is a migration target, not a requirement to move every component in one PR.

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

## Runtime migration

After renderer modules are split, `electron/agent-runtime-core.js` should be decomposed without changing the public Harness contract:

```text
electron/runtime/
├─ run-loop.js
├─ provider-stream.js
├─ conversation.js
├─ tool-dispatcher.js
├─ approvals.js
├─ self-check.js
├─ subagents.js
└─ evidence.js
```

The final `runHarness()` should coordinate these modules rather than own their implementations.

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

- [ ] Move Conversation/Composer/Route/Settings out of `main.jsx`.
- [ ] Reduce `main.jsx` to app bootstrap and top-level composition.
- [ ] Extract Harness-event reduction from `App` into a dedicated hook/reducer boundary.
- [ ] Add selector-level tests for active task/run/message state.

### Phase 3 — Runtime modules

- [ ] Split provider streaming and conversation loop.
- [ ] Split tool dispatch / approval.
- [ ] Split self-check / subagent orchestration.
- [ ] Keep Harness event shapes backward compatible while moving code.

### Phase 4 — Unified capability layer

- [ ] Register Native/Browser/Plugin/MCP capabilities through one adapter contract.
- [ ] Make Route/Witness labels derive from capability metadata instead of per-feature UI patches.
- [ ] Build the Extensions settings surface on top of the unified registry.

## Validation gates

Phase 1 is guarded by:

```text
npm run test:task-store
npm run test:runtime-ui
npm run test:process-ui
npm run test:renderer-architecture
npm run test:skills
npm run test:architecture
npm run build
```

The migration workflow must pass all gates before committing the codemod result to the branch.

## Non-goals

- rewriting the application from scratch
- changing model behavior while moving UI state
- replacing the existing Harness or Builder design
- moving the local Agent runtime to a server
- removing local-first / BYOK support

The v0.6 refactor succeeds when adding the next capability no longer requires touching five unrelated state/rendering paths just to make it observable in the UI.

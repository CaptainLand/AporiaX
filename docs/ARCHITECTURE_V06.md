# AporiaX v0.6 Architecture Consolidation

AporiaX v0.6 is an incremental architecture consolidation. It is **not** a rewrite.

The goal is to preserve the current product behavior while removing the duplicated state paths and DOM-patching bridges that now make small UI/runtime changes expensive and fragile.

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

The product works, but several presentation features currently observe the same run through different paths:

```text
React task state
Desktop task JSON
localStorage cache
Harness event stream
MutationObserver / injected React roots
```

That duplication has already produced one class of failures repeatedly: a task continues to run correctly while elapsed time, live status, or process UI becomes stale because a presentation bridge matched a cached message instead of the live React message.

## v0.6 invariants

1. **One live task truth** — the in-memory TaskStore is the only live renderer state.
2. **Persistence is not state** — desktop JSON is durable storage; localStorage is only an optional startup cache.
3. **Message UI receives messages directly** — elapsed time, live status, process trace, prompt folding, Witness, and response streaming must render from the same React message object.
4. **No DOM reverse lookup for application state** — MutationObserver may not be used to discover which task/message is active.
5. **Harness events reduce into state once** — UI components do not independently subscribe and reconstruct task state.
6. **Capabilities share one boundary** — Native, Browser, Plugin, and MCP tools eventually enter one capability/tool host before Permission → Approval → Witness.
7. **Behavior before movement** — tests lock existing behavior before code is moved out of `main.jsx` or `agent-runtime-core.js`.

## Target renderer

```text
Harness event
    ↓
Run reducer
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
    ├─ Route
    └─ Settings
```

No component in this tree should need to query `.assistant-message`, inspect localStorage, or mount a second React root into an existing React-rendered node.

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
│  └─ WorkspaceMentionMenu.jsx
├─ route/
│  └─ RouteView.jsx
├─ settings/
│  ├─ SettingsPanel.jsx
│  └─ ExtensionsPanel.jsx
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

The new store core is intentionally framework-light. React will consume it through `useSyncExternalStore` after the migration reaches App state.

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

Every committed mutation increments a revision and retains lightweight mutation metadata for diagnostics.

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

Once desktop loading succeeds, even an empty desktop task list is authoritative. A truncated localStorage cache must never replace or remap live messages.

## Conversation migration

`src/conversation/RuntimeMessageUI.jsx` defines native React versions of:

- task elapsed-time chip
- Live Agent Status
- Agent Process trace
- long user-prompt folding

During the migration, the existing presentation bridges remain enabled so the branch stays behavior-compatible until `AssistantMessage` / `UserMessage` are switched to these components. After the switch, the corresponding DOM bridges are deleted in the same change so two implementations never remain active in production.

## Runtime migration

After renderer state is consolidated, `electron/agent-runtime-core.js` should be split without changing the public Harness contract:

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
- [x] Add native React runtime-message components.
- [ ] Switch `App` task state to TaskStore.
- [ ] Render runtime message UI natively from `AssistantMessage` / `UserMessage`.
- [ ] Delete duration/process/live-status/prompt-folding DOM bridges.
- [ ] Move workspace mention menu into Composer React state.
- [ ] Move Vision/Skill capability cards into Settings React state.

### Phase 2 — Renderer modules

- [ ] Move Conversation/Composer/Route/Settings out of `main.jsx`.
- [ ] Reduce `main.jsx` to app bootstrap and top-level composition.
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

## Non-goals

- rewriting the application from scratch
- changing model behavior while moving UI state
- replacing the existing Harness or Builder design
- moving the local Agent runtime to a server
- removing local-first / BYOK support

The v0.6 refactor succeeds when adding the next capability no longer requires touching five unrelated state/rendering paths just to make it observable in the UI.

# AporiaX Harness Architecture v1

This branch introduces the first migration layer from a monolithic desktop harness to a modular Agent runtime platform. It intentionally keeps the existing task execution path compatible while establishing stable boundaries for the next refactor.

## 1. Event Bus + Hook API

`electron/harness/event-bus.js` is the common event backbone. It supports exact and wildcard subscriptions, ordered hooks, bounded event history, synchronous delivery for the current runtime, and an async delivery path for future blocking hooks.

`createEventEmitter()` in `agent-core.js` now uses this bus without changing existing callers. Existing `sequence` and `timestamp` behavior is preserved.

## 2. Declarative Agent Definitions

`electron/harness/agent-definitions.js` defines the built-in Explore, Review, Verify, and Curator roles as data and can load trusted workspace definitions from `.aporiax/agents/*.md`.

Example:

```md
---
name: security-review
extends: review
tools: ["read_file","search_text","git_diff"]
maxRounds: 5
background: true
triggers: ["changes.batch.ready"]
---
Focus on authentication, authorization, secrets, and injection risks.
```

The current legacy runtime still owns its built-in role switch. The new registry is the migration target for moving those hard-coded branches out of `agent-runtime.js` without a risky one-shot rewrite.

## 3. Runtime Boundaries

The new harness folder separates responsibilities that were previously concentrated near the main runtime loop:

- `session.js` — lifecycle and session state
- `scheduler.js` — prioritized concurrency and background jobs
- `context-controller.js` — token accounting, relevant context, compaction, and checkpoints
- `tool-host.js` — tool descriptors, permissions, and plugin tool registration
- `review-coordinator.js` — file-version tracking and stale-review rejection
- `agent-definitions.js` — agent role configuration
- `event-bus.js` — event delivery and hooks
- `plugin-api.js` — extension registration
- `kernel.js` — composition root

This is an incremental strangler migration: new behavior should move behind these modules instead of making `agent-runtime.js` larger.

## 4. Plugin API

Plugins receive a constrained API for events/hooks, agent registration, and tool registration. Project-local executable plugins are not auto-loaded; `loadPluginModule()` requires the caller to explicitly set `allowLocalCode: true` because plugin JavaScript executes with the current process privileges.

The current task executor does not yet consume plugin-defined tools. The API is deliberately established first so the tool executor can migrate to it behind tests.

## 5. Core Server + Desktop Client Boundary

`electron/main-v2.js` becomes the Electron entry point and imports the existing desktop main process for full backward compatibility. It also starts a loopback-only Harness Core Server with a random bearer token.

The v1 Core API is read-only:

- `GET /v1/health`
- `GET /v1/snapshot`
- `GET /v1/agents`
- `GET /v1/plugins`
- `GET /v1/sessions`
- `GET /v1/events`

`core-client.js` is the client SDK foundation for a future CLI, IDE extension, browser UI, or separate desktop process. The Electron preload exposes the same read-only Core status through IPC.

Task execution RPC is intentionally `false` in the v1 capability map. Moving credentials, approvals, run control, and workspace mutation behind the server should happen after the event/session boundaries are proven, not as an unsafe one-shot rewrite.

## Migration direction

The next safe migration sequence is:

1. Route Witness and UI consumers through the shared Event Bus.
2. Make `delegate_subagent` resolve roles from `AgentDefinitionRegistry`.
3. Move progressive Review/Verify scheduling into `HarnessScheduler` + `ReviewCoordinator`.
4. Let `PluginHost` contribute ToolRegistry descriptors through explicit permissions.
5. Move `harness:run`, pause/resume/steer, approvals, and recovery behind authenticated Core RPC.
6. Leave Electron as a pure client once parity tests pass.

# AporiaX Harness Architecture v2

Harness v2 adds adaptive Agent cost control and a conflict-safe execution path for parallel write-capable Builder agents while keeping the proven 0.4.1 task loop as the low-level execution engine during migration.

## Adaptive Agent Budget

Every desktop `harness:run` is wrapped in a per-run `AsyncLocalStorage` budget before the task runtime starts. The initial profile is chosen by deterministic local heuristics, so AporiaX does not spend another model request merely to decide whether it should spend model requests.

| Profile | Typical task | Total subagents | Max active | Builder budget |
| --- | --- | ---: | ---: | ---: |
| `direct` | simple Q&A / no workspace | 0 | 0 | 0 |
| `read` | focused repository investigation | 1 | 1 | 0 |
| `light` | small write task | 1 | 1 | 0 |
| `standard` | multi-step implementation | 4 | 2 | 0 |
| `large` | large multi-module / explicitly parallel work | 7 | 4 | 2 |

For `direct` tasks, `delegate_subagent` is removed from the model tool catalog. For other profiles, every `subagent.started` event is checked before the subagent's first provider request. Total, concurrent, and per-role limits are hard boundaries.

The Main agent can now actually call `update_plan`; plan growth and changed-file growth can therefore escalate the active budget when a task turns out to be larger than its initial prompt suggested. Escalation never reduces an already-consumed budget and never creates Agents by itself.

## Runtime facade and execution engine

The proven task loop remains in `electron/agent-runtime-core.js`. `electron/agent-runtime.js` is a small orchestration facade that re-exports the runtime API and overrides only `runHarness()`.

The important migration change is that the compatibility loop is no longer the owner of delegated Agent lifecycle. Explore / Review / Verify / Curator now enter the Harness Kernel through `AgentDefinitionRegistry -> HarnessScheduler -> HarnessSessionStore` before the existing bounded subagent loop performs the actual model/tool work. This preserves mature execution behavior while moving identity, scheduling, session state, and lifecycle observation to the v2 Kernel.

The root Main task is owned by `HarnessTaskRuntime`. Builder-eligible large write tasks continue to use the v2 Task Graph / Scheduler / isolated-worktree path. Keeping root Main outside the same finite scheduler queue avoids a parent task occupying a scheduler slot while it waits for its own delegated children.

## Durable task runtime

`HarnessTaskRuntime` is now the single owner of live run control state:

- active run identity and AbortController;
- pause / resume state;
- steering queue;
- pending approvals and run-scoped approval grants;
- event journal writes;
- recovery lookup;
- Core RPC task control.

Desktop IPC and authenticated Core HTTP call the same runtime instead of maintaining separate run maps. Renderer callbacks are observers only; if a renderer disappears, event delivery can fail without terminating the run.

On Windows/Linux, closing the last AporiaX window no longer automatically aborts an active task or quit the Electron main process. A second app launch can reconnect to the existing single-instance process and query active tasks. If the entire Electron process or machine stops, the live provider/tool call cannot continue in memory, but the SQLite journal remains authoritative for recovery on the next process start.

## SQLite append-only Event Store

Run persistence is now stored in `aporiax-runs.sqlite3` using Node's built-in SQLite runtime. The durable model separates current run projection from the immutable event stream:

- `runs`: current durable run projection and recovery metadata;
- `run_events`: ordered append-only lifecycle/tool/control events;
- `event_store_meta`: schema/migration markers.

SQLite uses WAL mode and keeps event sequence ordering in the database. Existing `aporiax-runs/*.json` and `*.jsonl` journals are imported once on first open and are left intact as rollback evidence. The public run-store API remains compatible with the previous implementation so callers do not need a flag-day migration.

This gives recovery code one ordered source for replay, audit, pause state, steering history, and run completion instead of reconstructing state from independent JSON files.

## Core HTTP task RPC

The loopback Core Server now exposes authenticated task RPC through the same bearer token used by the existing Core API:

- `GET /v1/tasks`
- `POST /v1/tasks`
- `GET /v1/tasks/:runId`
- `POST /v1/tasks/:runId/pause`
- `POST /v1/tasks/:runId/resume`
- `POST /v1/tasks/:runId/interrupt`
- `POST /v1/tasks/:runId/steer`
- `POST /v1/tasks/:runId/approvals/:approvalId`
- `POST /v1/tasks/:runId/acknowledge-recovery`

The Core client exposes matching methods. Task creation is enabled only when the desktop bootstrap installs a trusted task starter; a bare Kernel/Core pair therefore does not silently gain model credentials or provider access.

Provider credential resolution, secure-storage access, extension preparation, and model-provider construction still live in the trusted desktop adapter today. They feed the shared Task Runtime rather than being owned by the renderer. Moving the Core into a separately supervised OS process is a later deployment hardening step, not required for renderer-lifetime independence.

## Builder preflight

A Builder-eligible task receives one orchestration preflight model call. This extra call is intentionally limited to tasks whose local budget already permits Builders; simple Q&A, read-only work, small edits, and normal `standard` tasks do not pay for it.

The planner may return at most two Builder tasks. Every task must include:

- a stable task id;
- a self-contained implementation instruction;
- explicit workspace-relative `writeScopes`;
- optional Builder-to-Builder dependencies.

A plan is rejected if scopes overlap. The workspace root (`.`), `.git`, and `.aporiax/worktrees` are reserved and cannot be leased to a Builder.

If the planner declines parallelism or returns an invalid split, the Lead/Main runtime simply performs the task normally.

## Declarative Agents

`main`, `explore`, `review`, `verify`, `curator`, and `builder` are represented in the Kernel Agent registry. Workspace `.aporiax/agents/*.md` definitions participate in resolving delegated roles.

For read-only delegated roles, the resolved definition constrains the runtime prompt, maximum rounds, and available tool set before the existing subagent execution loop starts. A tool must be allowed by both the subagent role policy and the resolved Agent definition.

The default Builder remains deliberately narrow and runs through the isolated worktree orchestration path with a zero-subagent nested budget.

## Scheduler and Task Graph

The orchestration facade converts an accepted Builder plan into a `TaskGraph` and submits ready Builder nodes to `HarnessScheduler` with concurrency capped by both the task budget and the hard v2 Builder maximum of two.

Read-only delegated Agents are also submitted through the Kernel scheduler and get a Harness session before their execution loop starts. Dependencies for Builder work continue to be controlled by the Task Graph. The Main/Lead remains the single integration authority.

## Scope leases and isolated worktrees

Before a Builder starts modifying files, `ScopeLeaseManager` reserves its write scopes. Same, ancestor, or descendant scope collisions are rejected, so `src/auth` conflicts with `src/auth/login.js`, while `src/auth` and `src/ui` may proceed together.

`BuilderWorkspaceManager` creates a detached Git worktree for each worker. Tracked dirty files are overlaid so Builders see the user's current tracked project state. Untracked files are overlaid only when they are inside that Builder's leased scope; unrelated local archives, release outputs, and other untracked directories are not copied into every Builder worktree.

The real workspace is not changed while a Builder works.

## Conflict-checked merge

When a Builder finishes, AporiaX:

1. detects Builder-induced dirty paths and rejects out-of-scope changes;
2. computes the scoped text delta;
3. rejects binary Builder changes in v2;
4. compares every target in the real workspace against the baseline captured when that Builder worktree opened;
5. rejects the entire merge if Main, the user, or another process changed any target concurrently;
6. applies scoped changes only after preflight succeeds;
7. rolls back already-written paths if a partial write fails;
8. emits normal `file.changed` events only after the real workspace merge succeeds.

Builder merge checkpoints use the same before/after shape as normal workspace changes, so the orchestration-wide Anchor can represent Builder work together with later Main changes.

## Lead/Main integration

After the Builder wave completes, the normal Main execution engine resumes against the real workspace. It receives a concise integration message describing merged Builder scopes, changed paths, summaries, and failures.

The Lead is instructed to inspect the current diff and re-read Builder output before trusting it, then handle shared files, cross-cutting integration, unresolved Builder work, review findings, and verification. It should not redo correct Builder work merely to create activity.

The final facade captures the whole workspace delta from before orchestration to after Main completion. This makes the returned `changes` and Anchor orchestration-wide rather than only Main-run-local.

## Witness and cost visibility

Builder lifecycle and tool events are projected as subagent activity to the outer Witness. Kernel-routed delegated Agents also emit `agent.runtime.queued`, `agent.runtime.started`, and terminal lifecycle events backed by Harness sessions.

The orchestration result records the budget profile, planner rationale, Builder scopes, status, and changed paths. The cost rule remains conservative: Builder orchestration is an optimization for large decomposable write tasks, not a default behavior.

## Current migration boundary

Harness v2 now routes runtime ownership approximately as:

```text
Renderer IPC ---------\
                       -> HarnessTaskRuntime -> Main execution engine
Core HTTP taskRpc ----/          |
                                  +-> SQLite append-only Event Store
                                  +-> Kernel event bus
                                  +-> delegated Agent broker
                                          |
                                          +-> AgentDefinition Registry
                                          +-> Scheduler
                                          +-> Session Store
                                          +-> Explore / Review / Verify / Curator execution

Large write task -> Builder Preflight -> Task Graph -> Scheduler
                 -> Scope Lease -> isolated Git Worktree
                 -> conflict-checked merge -> Main integration
```

The remaining compatibility boundary is the low-level Main/subagent model-tool execution code itself. The lifecycle and scheduling ownership has moved to v2, but the mature loops are intentionally reused rather than rewritten in one change.

A separately supervised Core OS process, automatic crash-resume from an arbitrary provider/tool boundary, and durable credential/approval services remain later hardening work. SQLite recovery now provides the durable basis for those steps.

## Validation

`npm run test:harness-v2` continues to cover Builder orchestration. CI additionally exercises the P0 runtime boundary with network-free smoke tests:

- SQLite schema creation, legacy JSON/JSONL migration, ordered replay, close/reopen durability;
- detached Task RPC start/status/pause/steer/resume/interrupt and recovery;
- renderer/client event failure not terminating detached task execution;
- Agent Registry -> Scheduler -> Session routing for delegated Agents;
- simple Q&A -> zero-subagent budget;
- small write -> one-subagent budget;
- large multi-module task -> two-Builder allowance;
- plan-driven budget escalation and hard role denial;
- declarative Builder permissions and zero nested delegation/command access;
- overlapping scope rejection;
- Task Graph dependencies;
- isolated worktree edits and conflict-safe merge.

Before promotion, run the full Windows repository suite and manually test closing/reopening the renderer during a real long-running model/tool task.

# AporiaX Harness Architecture v2

Harness v2 adds adaptive Agent cost control and a conflict-safe execution path for parallel write-capable Builder agents while keeping the proven 0.4.1 task loop available as the compatibility core.

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

## Runtime facade and compatibility core

The previous runtime is preserved byte-for-byte as `electron/agent-runtime-core.js`. `electron/agent-runtime.js` is now a small orchestration facade that re-exports the existing runtime API and overrides only `runHarness()`.

This keeps the established Main / Explore / Review / Verify / Curator / Anchor / Context behavior intact for ordinary tasks. When the current budget has no Builder capacity, the facade takes the exact legacy path without a Builder planner call.

Only Builder-eligible large write tasks enter the orchestration path.

## Builder preflight

A Builder-eligible task receives one orchestration preflight model call. This extra call is intentionally limited to tasks whose local budget already permits Builders; simple Q&A, read-only work, small edits, and normal `standard` tasks do not pay for it.

The planner may return at most two Builder tasks. Every task must include:

- a stable task id;
- a self-contained implementation instruction;
- explicit workspace-relative `writeScopes`;
- optional Builder-to-Builder dependencies.

A plan is rejected if scopes overlap. The workspace root (`.`), `.git`, and `.aporiax/worktrees` are reserved and cannot be leased to a Builder.

If the planner declines parallelism or returns an invalid split, the Lead/Main runtime simply performs the task normally.

## Declarative Builder Agent

`builder` is now a built-in `AgentDefinition`, so workspace `.aporiax/agents/*.md` definitions participate in resolving the Builder role instead of Builder being a kernel-only special case.

The default Builder is deliberately narrow. It can inspect/search Git state and edit text with `write_file` / `apply_patch`; it cannot execute arbitrary commands, create Office binaries, or delegate another Agent. Builder child runs receive a zero-subagent nested budget.

## Scheduler and Task Graph

The orchestration facade converts the accepted plan into a `TaskGraph` and submits ready Builder nodes to `HarnessScheduler` with concurrency capped by both the task budget and the hard v2 Builder maximum of two.

Dependencies control readiness. A dependent Builder cannot start until its prerequisite Builder has completed successfully. The Main/Lead remains the single integration authority.

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

After the Builder wave completes, the normal Main runtime resumes against the real workspace. It receives a concise integration message describing merged Builder scopes, changed paths, summaries, and failures.

The Lead is instructed to inspect the current diff and re-read Builder output before trusting it, then handle shared files, cross-cutting integration, unresolved Builder work, review findings, and verification. It should not redo correct Builder work merely to create activity.

The final facade captures the whole workspace delta from before orchestration to after Main completion. This makes the returned `changes` and Anchor orchestration-wide rather than only Main-run-local.

## Witness and cost visibility

Builder lifecycle and tool events are projected as subagent activity to the outer Witness. The orchestration result records the budget profile, planner rationale, Builder scopes, status, and changed paths.

The cost rule remains conservative: Builder orchestration is an optimization for large decomposable write tasks, not a default behavior.

## Current migration boundary

Harness v2 now has real Builder execution through:

```text
Adaptive Budget
    -> Builder Preflight
    -> AgentDefinition Registry
    -> Task Graph
    -> Scheduler
    -> Scope Lease
    -> Isolated Git Worktree
    -> Conflict-Checked Merge
    -> Lead/Main Integration
    -> existing Review / Verify / Anchor pipeline
```

The existing read-only `delegate_subagent` implementation for Explore / Review / Verify / Curator still uses the compatibility runtime internally. Migrating every legacy subagent path to the new registry/scheduler is a later cleanup step; Builder execution does not bypass the new v2 safety path.

Core HTTP `taskRpc` also remains disabled. Task credentials, approvals, pause/resume, and mutation control still stay in the desktop runtime until the Core Server migration is ready.

## Validation

`npm run test:harness-v2` now covers both primitives and a mocked end-to-end Builder orchestration without making paid/network model calls:

- simple Q&A -> zero-subagent budget;
- small write -> one-subagent budget;
- large multi-module task -> two-Builder allowance;
- plan-driven budget escalation and hard role denial;
- `update_plan` availability for Main;
- declarative Builder permissions and zero nested delegation/command access;
- overlapping scope rejection;
- Task Graph dependencies;
- scoped untracked source overlay without copying unrelated large untracked output;
- isolated worktree edits;
- out-of-scope edit rejection;
- successful conflict-free merge with reversible checkpoints;
- concurrent Main/user edit causing merge rejection without overwrite;
- planner -> two Builders -> safe merge -> Lead integration end to end.

Before promoting v2, run the full Windows repository suite:

```text
npm run test:harness-v2
npm run test:architecture
npm run test:cache
npm run test:runtime
npm run build
npm start
```

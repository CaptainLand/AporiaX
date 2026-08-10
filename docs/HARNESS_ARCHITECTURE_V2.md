# AporiaX Harness Architecture v2

This branch continues the v1 migration with two goals: stop cheap tasks from spawning an expensive Agent team, and establish a safe foundation for parallel write-capable Builder agents.

## Adaptive Agent Budget

Every desktop `harness:run` is wrapped in a per-run `AsyncLocalStorage` budget before the existing runtime starts. The current runtime therefore receives a real enforcement boundary without a risky rewrite of `agent-runtime.js`.

The default profiles are intentionally conservative:

| Profile | Typical task | Total subagents | Max active | Builder budget |
| --- | --- | ---: | ---: | ---: |
| `direct` | simple Q&A / no workspace | 0 | 0 | 0 |
| `read` | focused repository investigation | 1 | 1 | 0 |
| `light` | small write task | 1 | 1 | 0 |
| `standard` | multi-step implementation | 4 | 2 | 0 |
| `large` | large multi-module / explicitly parallel work | 7 | 4 | 2 |

The initial profile is selected with deterministic local heuristics. There is no extra LLM call just to decide how many Agents to start. The budget can escalate during a run when the Main agent creates a larger plan or the task grows across several changed files.

For `direct` tasks, `delegate_subagent` is removed from the model tool catalog entirely. For other profiles, every `subagent.started` event is checked before the subagent makes its first model request. Exceeding the total, concurrent, or per-role limit raises `APORIAX_AGENT_BUDGET`, so the extra subagent does not consume model tokens.

The current budget snapshot is attached to `turn.started`, making the decision visible to the event/Witness pipeline.

## Builder scope leases

`ScopeLeaseManager` reserves explicit workspace-relative write scopes for Builder workers.

Rules:

- Builder write scope cannot be `.`.
- `.git` and `.aporiax/worktrees` are reserved.
- Two active Builder leases may not use the same path or ancestor/descendant paths.
- `src/auth` therefore conflicts with `src/auth/login.js`, while `src/auth` and `src/ui` may run in parallel.

This makes write ownership explicit before a Builder starts.

## Isolated Builder workspace

`BuilderWorkspaceManager` creates a detached Git worktree for each Builder, then overlays the current tracked/untracked dirty workspace state so the worker sees the user's current project rather than only the last commit.

A Builder works inside the isolated worktree. Its output is not copied directly into the real workspace.

At merge time AporiaX:

1. computes changes only inside the Builder's leased scopes;
2. compares the real workspace against the Builder's captured baseline;
3. refuses the whole merge if any changed target was modified concurrently;
4. applies the scoped changes only when the baseline still matches;
5. rolls back already-applied files if a write fails part way through;
6. removes the temporary worktree and releases the scope lease.

This gives Builder work the same basic principle as Anchor recovery: never silently overwrite newer user/Main work.

## Task Graph

`TaskGraph` represents dependency-aware work such as:

```text
plan
 ├─ auth (Builder A: src/auth)
 └─ ui   (Builder B: src/ui)
       ↓
     verify
```

Only dependency-complete nodes become ready. Builder nodes carry explicit `writeScopes`, so the scheduler can combine task dependency checks with scope leases before parallel execution.

## Current integration status

The adaptive budget is active for the existing desktop runtime in this branch.

The Builder definition, Task Graph, scope lease manager, and isolated worktree manager are implemented and tested as Harness primitives. `kernel.capabilities().builderExecution` remains `false` intentionally: the legacy `delegate_subagent` implementation still only knows its original read-only roles. Builder execution will be enabled only after `delegate_subagent` is migrated to `AgentDefinitionRegistry` + `HarnessScheduler`, so write-capable workers cannot bypass the new scope/merge safety layer.

That ordering is deliberate: AporiaX now has the safety mechanism before it gains the ability to launch write-capable subagents.

## Validation

`npm run test:harness-v2` covers:

- simple Q&A -> zero-subagent budget;
- small write -> one-subagent budget;
- large multi-module task -> two-Builder allowance;
- dynamic escalation from a larger plan;
- hard denial after the Builder role limit is exhausted;
- overlapping scope rejection;
- Task Graph dependency readiness;
- isolated Git worktree edits not touching the real workspace before merge;
- successful conflict-free merge;
- external/Main concurrent edit causing merge rejection without overwrite.

Before merging this branch, also run the existing suites:

```text
npm run test:harness-v2
npm run test:architecture
npm run test:cache
npm run test:runtime
npm run build
npm start
```

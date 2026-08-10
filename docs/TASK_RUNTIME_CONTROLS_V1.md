# AporiaX Task Runtime Controls v1

This stage adds two small desktop controls on top of Desktop Background v1:

1. elapsed task runtime in the conversation and system tray;
2. an explicit Single / Multi-Agent switch beside the model selector.

The implementation intentionally stays in the incremental desktop shell rather than rewriting the large compatibility React renderer.

## Runtime display

Every visible assistant turn receives a compact elapsed-time chip in its heading, beside the existing Anchor control when an Anchor exists.

The renderer-side clock reads the task history already persisted by AporiaX:

- `createdAt` is the start boundary;
- `completedAt` is the completed boundary;
- while `status === running`, the chip advances once per second.

Examples:

```text
AporiaX  Anchor  8.4s
AporiaX  Anchor  2m 17s
AporiaX  Anchor  1h 3m 12s
```

The clock is presentation-only. It does not alter task history, Anchor state, model context, or Harness evidence.

## Tray runtime

Desktop Background keeps the start time of each active `harness:run`. While work is active, the tray menu and tooltip refresh once per second:

```text
1 个任务正在后台运行 · 2m 17s
```

The timer stops automatically when no runs remain. Duplicate run-id references continue to be reference-counted so a duplicate lifecycle attempt cannot prematurely clear the tray state.

## Agent mode switch

A compact control is injected immediately after the existing model selector:

```text
[model] [Multi]
[model] [Single]
```

**Multi is the default and recommended mode.** An existing explicit `Single` choice remains persisted in renderer localStorage as `aporiax.agent-mode.v1`; fresh/unset state starts in Multi. The renderer synchronizes the selected policy to the Electron main process through a narrow preload bridge.

The control is disabled while a task is already running. A topology change therefore always applies to the next run rather than silently changing the team halfway through a task.

The enabled Multi state uses the same neutral/accent visual language as the surrounding AporiaX controls: a small glowing underline driven by existing accent/current-color tokens instead of a hard-coded red state.

Hovering or keyboard-focusing the switch shows a compact explanation:

```text
Multi: adaptively uses extra Agents only when useful.
Single: Main only, with the lowest token/coordination cost.
Recommended: keep Multi enabled.
```

### Single

Single means Main only.

Harness receives a locked `direct` Agent budget:

```text
maxTotalSubagents: 0
maxActiveSubagents: 0
builderOrchestration: false
```

Explore, Builder, Review, Verify, Curator, and other subagents are disabled for that run. Witness remains available because it is an observational monitor rather than a delegated worker.

The budget is `locked`, so plan growth or changed-file growth cannot automatically escalate a user-selected Single run back into a multi-Agent topology.

### Multi

Multi means **adaptive multi-Agent mode**, not "always run Main + 2 Builders".

The desktop layer does not force an Agent Budget profile. Instead it leaves the existing Adaptive Agent Budget and orchestration rules in control:

```text
Simple task
    -> Main only

Read / investigation
    -> Main + useful read-only helper when budget allows

Medium task
    -> Main + useful Review / Verify / Explore according to the adaptive budget

Large safely decomposable write task
    -> Main / Lead
       -> Builder preflight
       -> Shared Contract + Plan Approval
       -> Task Graph / Scheduler
       -> 0, 1, or up to 2 isolated Builders
       -> Main integration
       -> Review / Verify when useful
```

So Multi is permission for AporiaX to form the useful team for the current task. A simple request can still stay entirely Main-only and pay no unnecessary subagent cost. A larger task can receive extra Agents as its plan and changed-file surface justify them.

Two Builders remains the hard maximum. The existing Builder preflight may use one Builder, two Builders, or decline Builder parallelization completely when safe non-overlapping scopes do not exist. This preserves Scope Lease, Worktree, Shared Contract, and conflict-check guarantees.

Review / Verify remain part of the adaptive quality pipeline rather than mandatory workers on every Multi run. Main remains the single final integration authority.

In short:

```text
Single = force exactly one working Agent (Main)
Multi  = allow AporiaX to automatically choose the useful Agent topology
```

This distinction is intentional: Multi switches **automatic multi-Agent orchestration on**, not every possible Agent on.

## Renderer integration boundary

The large compatibility renderer already stores all timing data and already exposes stable DOM landmarks such as:

- `.assistant-message-heading`
- `.composer-toolbar-left`
- `.model-trigger`

Desktop Background injects a tiny DOM control layer after `did-finish-load` and maintains it through a bounded `MutationObserver` plus a one-second timer. This keeps this UI stage isolated from the large `src/main.jsx` migration.

A future renderer decomposition can move these controls into native React components without changing their IPC or Harness semantics.

## Validation

Run:

```text
npm run test:task-controls
npm run test:desktop-background
npm run test:collaboration
npm run test:harness-v2
npm run test:architecture
npm run test:cache
npm run test:runtime
npm run build
npm start
```

Manual Windows checks:

1. On a fresh/unset mode state, confirm the composer shows `Multi` beside the model selector by default.
2. Confirm Multi is shown with the neutral/accent glowing underline rather than a red selected state.
3. Hover Multi/Single and confirm the tooltip explains both modes and recommends Multi.
4. Switch to Single, start a large task, and confirm no delegated subagent starts.
5. Confirm the assistant heading timer advances while the task runs and freezes when the turn completes.
6. Hide AporiaX to the tray and confirm the tray status includes elapsed runtime.
7. Return to Multi and run a simple task; confirm AporiaX may stay Main-only rather than forcing Builders.
8. Run a medium Multi task and confirm only useful helpers are selected when applicable.
9. Run a safely decomposable large multi-module write task and confirm adaptive orchestration can start up to two Builders.
10. While a task is running, confirm the Single/Multi button is disabled.
11. Confirm the Windows completion notification remains and the old AporiaX internal completion toast stays hidden.

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

Desktop Background now keeps the start time of each active `harness:run`. While work is active, the tray menu and tooltip refresh once per second:

```text
1 个任务正在后台运行 · 2m 17s
```

The timer stops automatically when no runs remain. Duplicate run-id references continue to be reference-counted so a duplicate lifecycle attempt cannot prematurely clear the tray state.

## Agent mode switch

A compact control is injected immediately after the existing model selector:

```text
[model] [Single]
[model] [Multi]
```

The selected mode is stored in renderer localStorage as `aporiax.agent-mode.v1` and synchronized to the Electron main process through a narrow preload bridge.

The control is disabled while a task is already running. A topology change therefore always applies to the next run rather than silently changing the team halfway through a task.

### Single

Single mode is the default and means Main only.

Harness receives a locked `direct` Agent budget:

```text
maxTotalSubagents: 0
maxActiveSubagents: 0
builderOrchestration: false
```

Explore, Builder, Review, Verify, Curator, and other subagents are disabled for that run. Witness remains available because it is an observational monitor rather than a delegated worker.

The budget is `locked`, so plan growth or changed-file growth cannot automatically escalate a user-selected Single run back into a multi-Agent topology.

### Multi

Multi mode enables the existing safe Builder architecture:

```text
Main / Lead
    |
Builder preflight
    |
Shared Contract + Plan Approval
    |
Task Graph / Scheduler
   / \
Builder A  Builder B
   \ /
Main integration
```

The desktop request receives a locked `large` budget with Builder capacity `2` and `builderOrchestration: true`.

`2` is a hard maximum, not a requirement to invent parallel work. The existing Builder preflight may still decline parallelization, or use fewer Builders, when the task cannot be split into safe non-overlapping scopes. This preserves Scope Lease, Worktree, Shared Contract, and conflict-check guarantees instead of forcing two workers onto tightly coupled code.

Review / Verify remain available to the existing quality pipeline in Multi mode. They are not additional production leaders; Main remains the single integration authority.

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

1. Confirm the composer shows `Single` beside the model selector by default.
2. Start a task in Single mode and confirm no delegated subagent starts.
3. Confirm the assistant heading timer advances while the task runs and freezes when the turn completes.
4. Hide AporiaX to the tray and confirm the tray status includes the same style of elapsed runtime.
5. After the task completes, switch to Multi mode. The control should turn pink/accented.
6. Run a safely decomposable multi-module write task and confirm Builder orchestration can start up to two Builders.
7. While a task is running, confirm the Single/Multi button is disabled.
8. Confirm the Windows completion notification remains and the old AporiaX internal completion toast stays hidden.

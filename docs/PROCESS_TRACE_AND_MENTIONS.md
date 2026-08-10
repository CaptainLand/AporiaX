# Agent Process Trace and Workspace Mentions

This feature adds two interaction layers to the AporiaX task surface: a persistent observable Agent process trace and `@` references to files inside the active workspace.

## Persistent Agent process trace

While a task is running, the assistant message now keeps a compact **Agent Process** section directly below the response area. It is built from the same persisted Harness `Witness`, `Route`, plan, change, and tool metadata that already power the detailed audit view.

The trace summarizes observable execution stages such as:

- understanding and loading context
- inspecting files or locations
- shaping the execution plan
- creating or modifying files
- running verification commands
- coordinating subagents / approvals
- preparing the final result

The currently active stage is shown as live. Completed stages remain visible, and the entire trace remains attached to the assistant turn after the task finishes because it is reconstructed from persisted task history rather than transient DOM state.

### Not raw chain-of-thought

The process trace intentionally does **not** expose a model's private chain-of-thought or hidden reasoning tokens. It presents concise summaries derived from observable Harness events, tool calls, paths, commands, plans, changes, and Witness records. This gives the user a Codex-style sense of what the Agent is doing while preserving the boundary between auditable execution evidence and private model reasoning.

The existing full Witness panel remains the detailed audit surface; the process trace is the compact conversational view.

## `@` workspace file mentions

Typing `@` in the task composer opens a workspace-file picker. AporiaX indexes the current workspace through the existing `workspace.listTree` IPC path and ranks matching files as the user types.

Keyboard controls:

- `Up` / `Down`: move selection
- `Enter` or `Tab`: insert the selected file
- `Esc`: close the picker

Safe ASCII paths are inserted as normal mentions:

```text
@src/main.jsx
```

Paths containing spaces, Chinese characters, or other non-ASCII characters are inserted with braces:

```text
@{docs/translation guide.md}
@{本地化/规则.md}
```

When the turn is submitted, Electron's main process resolves each mentioned file inside the authorized workspace and appends its text as user-selected project context before the normal Harness runtime receives the conversation. The visible user message remains unchanged.

Mentions also work in steering messages sent while a task is already running. `main-v2` retains the active run's workspace path only for the lifetime of that run and preprocesses the steering message before it reaches the existing run control.

## Safety boundaries

Workspace mentions are deliberately bounded:

- maximum 8 mentions per message
- maximum 256 KB per referenced file
- maximum 640 KB total referenced bytes per message
- maximum 120,000 characters inlined from one text file
- absolute paths are rejected
- resolved paths must remain inside the authorized workspace
- final symlink targets and non-files are rejected
- null-byte/binary files are not inlined
- unavailable files are represented by an explicit status rather than guessed content
- inlined file text is labeled as user-selected project context, not higher-priority instructions

Vision preprocessing runs before workspace-mention inlining. A separate Vision Provider therefore receives the original user prompt and image, not unrelated `@` file contents.

## Current scope

This is intentionally a first interaction layer, not a semantic repository index:

- file autocomplete uses the existing workspace tree and is capped at 4,000 indexed files / 260 visited directories per renderer session
- the index is cached for the current workspace session; newly created files may require a task/window refresh before appearing in autocomplete
- mentions inline text rather than creating a long-lived embedding/index entry
- directories are not currently mentionable
- binary/Office files remain available through the existing attachment / workspace tool paths rather than direct text inlining

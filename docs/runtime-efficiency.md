# Harness efficiency follow-up (0.7.2)

## Changes

- Context compaction replaces old checkpoints instead of stacking them, removes oldest complete exchanges until the request fits, and preserves tool-call/result pairs and the latest user request. An oversized indispensable request fails explicitly with `CONTEXT_BUDGET_EXCEEDED` instead of silently truncating the request.
- The orchestration planner may assign independent Main preparation inside explicitly owned shared-file scopes. It runs in an isolated worktree alongside Builders; integration remains after their handoffs. Dependents start when their own prerequisites finish, without a whole-batch barrier. Main preparation is optional, not an unconditional third worker.
- Explicitly optional background Explore/Curator work no longer blocks final delivery. Review/Verify remain required, as do background tasks by default. Cancellation preserves usage from completed model rounds; it cannot refund an in-flight provider request.
- Progressive Verify executes bounded native verification commands without a separate model. Existing approval, sandbox, watchdog and durable-operation policies still apply. Explicit checks take precedence; otherwise one discovered candidate is selected. Passing evidence is reused only while bound to the current file version. Review still uses a model.
- Response/Witness events are transaction-batched up to 100 ms, 64 events or 64 KB. UI updates are immediate. Critical events flush preceding buffered events; checkpoints, side-effect intent and completion wait for persistence. SQLite FULL durability remains enabled. A hard power loss can lose the final small buffered UI fragment, not a previously acknowledged operation intent.
- Anchor baseline capture is lazy, before the first potentially mutating authorized tool (including MCP). Intermediate scans reuse file data only when inode/size/mtime/ctime are unchanged. Final successful delivery forces a content read; interrupted cleanup uses a bounded scan and reports uncertainty. Existing snapshot coverage limits remain.
- Repeating the same non-progressing tool/input/result warns on the third occurrence and stops on the sixth while preserving work. Workspace changes and user steering reset the guard. Process polling and explicit coordination tools are excluded.

## Regression coverage

`npm run test:runtime-efficiency` covers repeated compaction, valid tool pairs, explicit oversize failure, version-bound deterministic verification and races, snapshot reuse/full reads, journal batching/rollback/intent ordering, no-progress detection, scoped Main normalization, queue cancellation, real Git worktree concurrency/dependency release, and optional-versus-required background collection with usage accounting.

Also run runtime, recovery/SQLite, streaming, self-check, broker/subagent, and steering suites before packaging. These are mocked-provider correctness tests, not a paid-model performance benchmark; no percentage latency or cost reduction is claimed.

# 0.9.7 architecture audit follow-up

Scope: the concrete defects identified against `c021fbb7009b34bf6d9f90998f15823cdbb263e8`. This is a source change proposal, not a release or a security certification. No production deployment, model requests, or main-branch write is performed by the audit workflow.

## Implemented protections

| Area | Change | Regression evidence |
|---|---|---|
| History migration | Durable pending/partial/completed marker; failed records retried; source never deleted on archive failure | `audit-reliability.mjs` |
| History corruption | Healthy records continue loading; original corrupt records retained; corrupt index makes writes read-only | `audit-reliability.mjs` |
| Storage concurrency | Unique flushed replacement files, serialized writers, snapshot revision checks and explicit deletion/tombstone archives | `task-history-store-smoke.mjs`, `audit-reliability.mjs` |
| Client persistence | Failed initial load cannot authorize an empty autosave; preload serializes revisioned saves | `audit-reliability.mjs` and desktop acceptance |
| Workspace writes | Native text writes, both patch paths and Office writes use the same recoverable commit primitive as Builder merges | `native-tool-executor-smoke.mjs`, `builder-merge-regression.mjs`, `audit-reliability.mjs` |
| Builder lifecycle | Explicit orchestration now uses the delegated Builder's snapshot, durable merge and retained-worktree lifecycle | `harness-v2-orchestration-smoke.mjs`, `runtime-autonomous-builder.mjs` |
| Concurrency | Kernel default admits six rather than silently capping the six-Builder setting at four; duplicate scheduler ids rejected | `audit-reliability.mjs` exercises Kernel Broker |
| Task lifecycle | Starting runs are reserved before awaiting journal IO; detached runs count toward tray and update protection through TaskRuntime | `task-runtime-rpc-smoke.mjs`, `audit-reliability.mjs` |
| Safe dependencies | Private dependency snapshots survive between successful commands within a task; manifest changes invalidate reuse; no host links | `sandbox-priority-regression.mjs`, `audit-reliability.mjs` |
| OCR | Mixed raster/text pages and force-OCR option; header dimension guard before native decode; separate child process for Canvas/WASM | `audit-reliability.mjs`, Windows `test:0.9.7` |
| Text reads | Streaming hash and bounded-memory pagination; long-line cursor advances by offset; explicit scan limit and UTF-8 validation | `native-tool-executor-smoke.mjs`, `audit-reliability.mjs` |
| IPC | Common main-frame/application-origin check for privileged handlers, exact production navigation target | `audit-reliability.mjs` and desktop acceptance |
| MCP | Deadline and abort forwarded to SDK; local wait bounded even if remote ignores cancellation; uncertain effects are not called undone | `mcp-runtime-smoke.mjs`, `audit-reliability.mjs` |
| Delivery pipeline | SQLite test flags at declared minimum Node version; Linux/Windows matrix; mandatory 0.9.7 desktop gate; explicit release channel | `.github/workflows/audit-reliability.yml`, release workflow |
| Docker | New image tag forces rebuild of the Node 22.16 runtime instead of reusing the Node 20 image | sandbox regression |

## Guarantees and deliberate boundaries

- A recoverable multi-file mutation is not an operating-system transaction. Retained manifests and originals allow inspection after failure; external filesystem writers can still race. Recovery backups are retained rather than automatically discarded when state is uncertain.
- History writer serialization is process-local, consistent with the desktop single-instance owner. Independent multi-process Core writers require a transactional store or inter-process owner protocol before they are enabled.
- A damaged history index is loaded diagnostically in read-only mode; automatic overwriting or destructive rebuilding is deliberately disabled. Original files remain available for explicit repair/export.
- Safe dependency reuse is task-local and only follows successful commands. Failed commands retain recovery folders. Dependency installs are not silently copied to the host. Resuming after process death may require reinstalling dependencies in a new private environment.
- OCR moves native allocations out of Electron Main and rejects oversized raster headers, but the V8 heap flag is not a hard native RSS limit. OS memory/job limits and hostile document parser fuzzing remain follow-up work.
- MCP cancellation is best-effort remotely. A cancelled or timed-out side-effecting call remains uncertain until reconciled; it must not be replayed as if nothing happened.
- `Safe` remains workspace-copy isolation, not a Windows AppContainer. Docker is the available OS-isolated backend; MCP/Browser have their own authority boundaries.
- The Core still runs inside Electron Main. This PR unifies task ownership and mutation/Builder services as preparation for supervised process extraction; it does not pretend to finish a separately supervised Core or arbitrary-point hot recovery.
- Windows publisher signing requires an owner-provided signing identity/certificate and is not fabricated. Actual installer upgrade, clean-machine behavior, native sandbox limits and a model task benchmark require separate acceptance.

## Verification

Run `npm run test:audit` for deterministic new scenarios and `npm run test:audit-suite` for the combined regression gate. The latter writes `.tmp/audit-results/regression.json` with per-script outcomes, platform and Node version. The workflow uploads this report and runs desktop OCR/UI/ASAR and package checks on Windows. Source-code pattern tests are supplemental, not a substitute for behavioral tests. Check the PR's final commit checks; an earlier passing run does not verify later edits.

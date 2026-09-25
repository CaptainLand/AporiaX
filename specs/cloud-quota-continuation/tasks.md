# Tasks

Latest approved revision: actual-use settlement, negative user balances, no user preallocation and 5% wind-down. User approved packaging, deployment and GitHub Release publication on 2026-09-25.

- [x] Expose settled weekly denominator and add durable, idempotent 5% wind-down instruction (8, 10).
- [x] Gate new, queued, system-owned and follow-up worker activations without blocking collection or BYOK (9).
- [x] Verify thresholds, parallel notification deduplication, recovery, truncation, and unchanged zero-quota pause locally (8–10).
- [x] Package Preview 6, verify artifacts, deploy with rollback and publish GitHub Latest. See docs/releases/1.0.0-preview.6-deployment.md.

- [x] Remove user hold/output reduction and recheck positive balance immediately before dispatch (1, 2, 7).
- [x] Settle actual-use requests below zero exactly once; retain signed remaining amounts and legacy recovery (2, 5).
- [x] Preserve settled responses and pause promptly on confirmed exhaustion, including truncation (3, 4).
- [x] Verify overdraft, parallel/queued requests, resume, reconciliation and provider daily guard; update verification (1–7).

Previous revision (superseded where noted above):

- [x] Implement atomic affordable admission and temporary-capacity classification (1, 2, 5).
- [x] Implement durable Desktop quota pause/resume and quota-limited truncation handling (2, 3, 4, 5).
- [x] Verify races, exhaustion, safe retry, cancellation, settlement and recovery locally (1–5).
- [x] Retire avatar UI and keep its source/data; verify default-off and opt-in browser paths (6).
- [x] Document test results and outstanding limits. Do not deploy or publish. See verification.md.

# Design

Preserve the existing desktop harness and Cloud gateway; do not introduce another orchestration system.

- Add managed-model output policy to Cloud request normalization/capabilities. Direct API behavior remains unchanged. Validate explicit caps; never silently shrink the selected thinking/output budget for quota reasons.
- Bind the managed Cloud protocol to DeepSeek while retaining its Cloud auth/identity route. Preserve reasoning internally, not in public UI.
- Add a safe upstream error classifier (bounded reads, allowlisted codes and Retry-After) and structured queue/terminal SSE metadata.
- Gate Cloud network requests locally with an abortable FIFO semaphore driven by advertised limits. Keep independent server per-user/device/global leases. Emit explicit queued/admitted events for main/subagents.
- Recover length truncation once through the common loop, with a new logical request only after a confirmed terminal response; preserve actual usage, omit incomplete tool calls and opaque partial reasoning, prefer smaller complete tool actions. Unknown outcomes remain reconciliation-required.
- Keep conservative worst-case cost reservation and actual settlement; distinguish insufficient reservation from zero balance and return safe available/required amounts. Align reserve estimation and advertised limits; no uncapped spending or hidden model downgrade.
- Store terminal reason as bounded metadata, not response contents. Keep backward-compatible receipts and migrations.
- Reuse existing Route UI styles for queue/limit status. No visual redesign.

Rollout: tests -> additive migration/backup -> compatible Cloud update -> desktop release if approved; retain Preview.4 minimum and rollback images. Mock is disabled in production catalog only after verifying its exact identity; tests may opt in explicitly.

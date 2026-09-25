# Local quota continuation

Approved scope: local implementation and tests only; no deployment or release.

1. While the user's settled balance is positive, Cloud shall allow inference without reserving user funds or reducing output to fit that balance. Actual usage may bring the balance below zero.
2. When settled balance reaches zero or below, Cloud shall reject new inference, including queued/admitted work not yet claimed for dispatch. Already-dispatched requests settle exactly once, even if they increase the negative balance.
3. When quota is exhausted, Desktop shall durably pause with confirmed history, files, responses and tool receipts intact, not mark the task failed. No new paid request may start without renewed positive balance.
4. When the user resumes after replenishment/reset, the task shall continue at the inference boundary without replaying confirmed tools or incomplete tool calls.
5. Weekly quota, the configured daily provider fuse (currently CNY 5 in production), unknown-spend protection and exactly-once settlement shall remain in force. BYOK shall remain unchanged.
6. Avatar UI is separately retired by default in Web and Desktop. Code, backend endpoints and saved photos remain; no avatar writes are made by hiding the UI.
7. Provider-wide daily risk holds remain separate from user quota. Only this retained daily safety guard may wait for provider-cost settlement or constrain output. Missing/uncertain usage must never be invented or automatically replayed.
8. When confirmed remaining weekly quota is positive and at most 5% of its base allowance (including bonus in the remaining amount, consistent with the quota bar), Desktop shall latch wind-down for the current run, notify once and add one persistent instruction to subsequent Cloud requests without extra model calls. At zero the existing durable pause takes precedence. Wallets without a defined allowance must not receive a fabricated percentage.
9. While winding down, new, queued and follow-up worker activations (including system-owned workers) shall not start. Already-running workers may finish safely; collecting results and existing permission/verification checks remain available. BYOK is unaffected.
10. When recovering an in-flight request, its original prompt and identity shall stay unchanged. Wind-down shall survive restart and compaction without repeated notifications or duplicate charges; missing/invalid/legacy quota metadata shall not trigger it.

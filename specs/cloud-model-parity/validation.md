# Cloud model parity — 2026-09-25

## Result and boundaries

Implemented, locally verified and packaged as Preview.5. Deployment and release are approved; activation is pending final remote checks. Preview.4 remains the minimum supported desktop version.

Desktop implementation was developed in `.tmp/cloud-parity-preview5` on `codex/cloud-model-parity`, based on published Preview.4 (`e77644aa72d082d74463cbec217ade009be6bc9f`). Only these verified changes are mirrored to the main desktop workspace; unrelated edits are retained.

Cloud source: `D:/Agent开发/.tmp/aporiax-cloud-server-preview`. Its pre-existing changes were retained. Do not replace it with the older separate Cloud copy or stage the entire dirty tree blindly.

## What changed

| Area | Previous behavior | New behavior |
| --- | --- | --- |
| Output budget | Default 4,096; accepted maximum 32,768 | Managed Flash defaults 8,192 non-thinking / 65,536 thinking / 131,072 max thinking; accepted maximum 393,216. Explicit caps are honored. |
| Thinking tool protocol | Managed Cloud lost reasoning_content at desktop wire compilation | Preserve required DeepSeek tool-continuation state for the managed model; unrelated models do not get it. |
| Length truncation | Reasoning-only and incomplete tool JSON failed immediately | One bounded generation repair, persisted across restart; discard incomplete calls, retain confirmed work and actual usage. |
| Error classification | Generic gateway error hid context/protocol rejection | Bounded, allowlisted public error codes enable existing compaction/repair. No raw upstream bodies or secrets exposed. |
| Concurrency | Builders could overload the smaller Cloud allowance | Account-wide FIFO uses advertised user/device/global slots, held through body consumption; cancellation removes waiters. Server limits remain authoritative. |
| Visibility | Queue could appear as model thinking/approval | Explicit Cloud queue/admission events for Main and subagents, visible in Route. |
| Reservation | 35% extra buffer applied to capped output too | Buffer estimated input only; reserve capped output once. Distinguish a nonzero but insufficient reservation from exhausted balance. Actual billing unchanged. |
| Completion accounting | A settled SSE could appear simply completed | Persist finish_reason; public generationOutcome distinguishes truncated/filtered/finished/unknown independently of billing. |
| Mock route | Enabled leftover test rows could be invoked | Mock provider works only under NODE_ENV=test; production seeding disables it without deleting history. |

DeepSeek contract checked against https://api-docs.deepseek.com/api/create-chat-completion/ and https://api-docs.deepseek.com/guides/thinking_mode/ . Output ceilings are not automatic charges or promises of complete tasks.

## Verified

- Cloud TypeScript build passed.
- Cloud compatibility unit: 20/20.
- Real gateway + PostgreSQL integration against a loopback fake provider: 24/24, including exact settlement, duplicate prevention, six requests / two slots, cancellation, session revocation, pending usage, safe errors, reservation diagnostics and twice-applied additive migrations.
- Provider timeout smoke passed.
- Desktop parity regression: 11/11.
- Outer Cloud recovery: 12/12.
- Desktop Cloud compatibility: 16/16.
- Harness recovery/provider tests: 11/11.
- Native protocol tests: 15/15.
- Automatic offline/sleep suspension: 15/15.
- Provider stream, durable context, Witness, Route model, privacy/no-sync and update smoke passed.
- Actual Edge/Playwright Route UI tests passed, including queue label, admission transition, narrow layout, light/dark themes, existing history/dialog/scroll behavior. Screenshots: `.tmp/route-activity/cloud-queue-light.png` and `cloud-queue-dark-narrow.png` in the isolated worktree.
- Desktop production frontend build passed; existing large-chunk warning remains.
- Preview.5 installer and portable packages passed byte-for-byte source, native PTY and updater SHA-512 validation.
- Actual packaged installer/portable-mode launches passed startup update checks, no-update sidebar hiding, production PKCE URL, offline/sleep resume and native terminal checks.
- Avatar API integration passed ownership, authentication, revocation, raster/size/pixel validation, metadata stripping and removal checks against an isolated test database.
- Web avatar select/preview/save/remove/error/reload/narrow-layout browser checks passed. Desktop avatar focus refresh, logout cleanup and account-menu contrast checks passed.

All inference in these checks was mocked. No paid model call, production account creation/deletion, or production data migration occurred. Tests used a separately initialized PostgreSQL cluster listening only on 127.0.0.1:65439, not the user's existing PostgreSQL service. The temporary cluster is stopped after verification; fixture data can be retained for inspection.

## Preserved protections and rollout checklist

Keep weekly entitlement, site-wide daily CNY 5 ceiling, authentication, TLS, body/image bounds, model deadlines, lease cleanup and owner-scoped request receipts. No silent output reduction or cheaper-model fallback to hide quota exhaustion. Unknown paid results remain reconciliation-required; never create a second paid request merely because the first lost its connection.

No remote file, project or conversation synchronization was reintroduced. Cloud inference still necessarily sends the selected model request/context to the gateway/upstream; that is distinct from background remote sync, and is not described as zero data transmission.

Approved rollout:

1. Back up deployment manifest and database; drain gateway/worker requests.
2. Run the existing guarded `db:migrate-desktop-v1 -- --apply` (now includes `20260925_model_parity.sql`). Do not use schema push on production.
3. Update API, gateway and worker consistently, because all share the schema. Preserve private env, daily/weekly limits and endpoint/security settings. Verify the exact obsolete mock row and disable it without deleting records.
4. Check health/capabilities/metadata and run a specifically approved short real inference if requested. Do not claim upstream live parity based only on mock results.
5. Package and verify Preview.5, then publish/download-check GitHub and the existing mirror. Keep Preview.4 as the minimum supported version unless separately authorized.
6. Retain old images/binaries for rollback. The nullable additive column may safely remain when rolling code back; do not roll back balances or delete request history.

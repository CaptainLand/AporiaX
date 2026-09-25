# Cloud model parity — approved repair scope

The user approved the five-part audit repair plan on 2026-09-25: protocol parity, output budgets, bounded recovery, truthful concurrency, and end-to-end verification.

1. When Cloud calls managed DeepSeek, it shall preserve the same required reasoning/tool protocol state as direct API calls; no state may cross an unrelated provider/model boundary.
2. When an output limit is omitted, Cloud shall use model-specific defaults (8K non-thinking, 64K high/low, 128K max), accept explicit limits up to the documented model ceiling, and publish those capabilities. Monetary limits shall remain 100 weekly Credits and CNY 5 daily site-wide.
3. When a completed stream is truncated, the runtime shall preserve confirmed history and usage and allow at most one explicit bounded repair, never execute truncated calls, and never silently replay an uncertain paid request.
4. When Cloud slots are occupied, tasks shall queue visibly without pretending model generation is occurring. Desktop scheduling shall honor advertised per-account/device limits; the server remains authoritative across devices.
5. When admission fails, errors shall distinguish insufficient reservation capacity, exhausted quota, context overflow, invalid parameters, queue pressure and uncertain billing; no secrets/upstream raw body shall be exposed.
6. When a request ends, accounting shall remain exact and idempotent; the receipt shall distinguish transport completion from length/content-filter termination. Existing account data and protections are preserved.
7. No remote file/project/conversation synchronization or server-side response-body archive may be reintroduced. Local durable memory remains local.
8. Existing private/public endpoints, authentication, TLS, firewall, minimum desktop version and daily cost ceiling shall not be loosened. Deployment/release awaits separate approval.

Acceptance includes pure protocol simulations, provider streaming tests, isolated database integration, UI queue-state tests, and packaged desktop validation. Live paid inference requires explicit approval; mocked evidence is not represented as live model success.

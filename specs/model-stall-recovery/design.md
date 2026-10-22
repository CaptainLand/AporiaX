# Design

Use a response-scoped watchdog whose clock advances only with useful model data.
Empty SSE/heartbeats and transport bytes are not useful data. All protocol
adapters feed it before presentation throttling. Explicit Cloud queue state and
user/system pauses suspend observation. No overall task/thinking deadline.

At 180 seconds of inactivity, perform a bounded recovery check. Where a Cloud
request receipt exists, query it using the original identity; only a matching,
released, zero-cost, not-dispatched receipt can permit a new dispatch. Generic
APIs have no safe replay contract: keep the original stream, report unsupported
reconnection honestly, and never issue a speculative duplicate inference.

Persist attempts per logical request and checkpoint partial public text (not
partial tool arguments). Three checks consume the automatic budget; original
stream may still deliver a late result. Once closed after a stall, keep the run
pending, not failed. User stop cancels all waits; explicit resume may start a
new *check* budget, never bypass the safe-dispatch contract.

Witness receives response.recovery.status events, holds no private reasoning,
and renders recovery/waiting/resumed descriptions using existing panel styles.
No backend deployment, UI redesign or new billable retry contract is introduced.

Tests use short injected windows and synthetic SSE; screenshots use the real
Conversation/Witness component and actual monitor event reducer, not mock HTML.

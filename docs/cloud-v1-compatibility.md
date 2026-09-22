# Cloud service compatibility (Desktop 1.0 Preview)

This companion update validates the server contract rather than assuming that a
signed-in account can always use a built-in model. It does not deploy a server,
change credentials, enable remote execution, or select an unverified production
hostname. The Cloud API/Gateway deployment must be upgraded independently.

## Availability

A selectable Cloud model requires an authenticated account AND a confirmed nonempty
model catalog containing that model. An empty or failed catalog disables Cloud but
does not log out the user or change their own Provider/Local model. When Gateway
capabilities v1 are present, per-model enablement, configuration and entitlement
must allow it. Missing capability support on a legacy server permits a confirmed
catalog with local quota checks; an unavailable modern Gateway fails closed.
This is configuration/entitlement validation, not a paid live model health probe.
A refreshed account updates the actual main/side-chat model pickers. Gateway calls
recheck stale availability before dispatch; the server remains authoritative for
exact cost and concurrent quota admission. Cloud availability does not guarantee a
particular large request fits remaining quota.

Remote controls and polling require an explicit `remote.supported:true` capability.
A stale `device.remoteEnabled` flag cannot enable an unsupported service. This is
safe capability gating, not a newly implemented remote command/file backend.

## Endpoints and credential boundary

Supply all three verified endpoints via the package-time manifest
`config/cloud-endpoints.json` (version 1) or explicit local configuration:

- `APORIAX_ACCOUNT_WEB_URL`
- `APORIAX_CLOUD_API_URL`
- `APORIAX_MODEL_GATEWAY_URL`

Manifest fields are `accountWebUrl`, `accountApiUrl`, `modelGatewayUrl` and
`version:1`. TLS is required outside loopback; URL credentials/query/fragment are
rejected. The Cloud repository provides a manifest generator using the operator's
verified `PUBLIC_*` values. Nothing is discovered from an untrusted network
response, and a Cloud deployment cannot change already-installed binaries.

Without a manifest or a complete explicit configuration, new Cloud login/inference
is unavailable instead of silently using the old private-preview destinations.
BYOK and local models are unaffected. For an intentional private legacy deployment,
`APORIAX_ALLOW_LEGACY_CLOUD_ENDPOINTS=true` restores the exact old defaults. Do not
ship that override as a production migration. Partial configuration is rejected.

Encrypted refresh credentials are bound to the three-endpoint fingerprint. A
configuration change requires login again, never silently sending an old refresh
token to a new server. A legacy unbound credential is only accepted with the exact
explicitly enabled legacy endpoints. The old encrypted record is not erased merely
because a newly configured server differs. The manifest and shared runtime module
are included and byte-verified by the Windows package check.

## Requests, streaming and billing

Cloud requests send bounded task/run/agent attribution and separate logical/attempt
IDs. Inner transport retries before an HTTP outcome reuse the idempotency key;
explicit HTTP rejections may start a linked new attempt. A known duplicate is not
retried and a returned pending-accounting outcome stops automatic regeneration.
Refreshing auth preserves the original request key. A status endpoint is available
on the supporting server, but this patch does not implement cached-response or
partial-stream replay, nor a persisted across-restart request outbox. A deliberate
new inference can incur additional provider cost; it is not a free retry promise.

Cloud streams must end with `[DONE]`; finish_reason alone is insufficient. The
billing status event is recorded separately from raw model Token usage, and unknown
amounts remain null. A pending-usage count is visible in the account panel.
No prompts, keys or private reasoning are added to correlation headers.

## Validation

`node --experimental-sqlite tests/cloud-compatibility.mjs` exercises actual account
and Provider paths with a minimal Electron stub, local files and fixture responses:
empty/failed catalogs, unavailable entitlement, supported/unsupported remote,
endpoint validation, credential scope, IDs, retry identity, incomplete streams and
billing/usage separation. It makes no external request or real credential use.

The existing full-App onboarding browser test now includes authenticated empty
catalog, explicit quota denial, restored availability and unsupported remote UI,
while retaining draft, BYOK, logout and side-chat assertions. Windows Edge/production
packaging results must be read from the final CI run, not inferred from local Node
unit tests. Existing mainline failing tests are not disabled by this update.

Configure and verify the endpoints before releasing the Desktop companion. Server
changes alone cannot fix an already-installed 1.0 Preview's old defaults or UI.

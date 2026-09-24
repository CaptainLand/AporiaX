# Desktop preview 4

## Requirements and acceptance
- Every packaged launch checks the published latest channel, including the welcome screen. Reconnect/focus retries are bounded and concurrent checks coalesce.
- A persistent sidebar update entry works signed in or out, survives toast dismissal, and exposes failures with retry. No silent install or interruption of active tasks.
- Cloud rejects obsolete desktop authorization, token refresh, device registration and gateway use, including existing sessions. Web login and local/BYOK work remain available.
- Publish verified 1.0.0-preview.4 artifacts first, then activate the matching server minimum. A version header is compatibility information, not cryptographic client attestation.

## Design
Preserve the industrial/utilitarian sidebar, inherited Inter/Segoe UI/Microsoft YaHei typography (existing design-system override). Palette: #287ca2 accent, #18191b text, #f5f6f7 surface; dark mode #7ddaff and #eeeaf2. Left-aligned compact entry above account, Lucide Download/RefreshCw icons. No layout or font redesign.

## Work and verification
1. Repair SemVer, latest feed, per-process scheduling and persistent UI; unit/runtime/browser tests.
2. Server minimum policy with structured 426 errors; account headers and actionable errors. Isolated HTTP/database regressions, no real model charges.
3. Package NSIS and portable; verify embedded source/privacy exclusions and update hashes.
4. Publish release and verify downloaded metadata/assets. Back up server source/image, deploy and activate minimum; probe old/new clients and web health. Keep rollback without restoring account data.

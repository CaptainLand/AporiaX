# Harness loop reliability and efficiency

## Scope and baseline

Implementation baseline: `3ff48b1000192d38b980b9c7d815ecc757e677d0` (main; package 0.9.8).
This change does not merge a PR, publish a release, change permissions, replace
TaskRuntime, or remove PR #62's durable storage and workspace protections.

The preceding research needs two corrections: the public `agent-context.js`
wrapper **already** retained DeepSeek cache-hit/miss counters and placed dynamic
retrieval near the conversation tail. Only the underlying core exported the older
behavior. The change unifies both import paths and expands usage normalization;
it does not claim to have introduced those existing wrapper capabilities.

## Implemented architecture

```text
TaskRuntime / existing durable journal and approval service
  -> main or delegated agent loop
       -> context accounting + bounded output pruning/checkpoint compaction
       -> RequestCompiler (stable tool order; existing history/authority preserved)
       -> Provider (attempt metrics, classified failures, server-directed retry)
       -> LoopRecovery (bounded inference repairs; never replay tool effects)
       -> ToolBatchExecutor (contiguous read pools and exclusive barriers)
       -> current tool dispatcher / durable operation boundary
       -> ProgressGuard and opt-in CompletionPolicy
       -> honest completed / partial / blocked / interrupted outcome
```

### Token accounting and cost evidence

The same completed request now calibrates to its reported prompt usage, rather
than adding a residual overhead twice. Changed conversations use a heuristic-delta
estimate anchored to the last complete request and explicit tool-schema overhead.
Multimodal requests retain conservative image accounting rather than training a
text ratio on images. Estimation is not an exact tokenizer or a billing promise.

`token-usage.js` normalizes and aggregates DeepSeek hit/miss counters, OpenAI-style
nested cached-token details, and raw exclusive `input_tokens` cache-read/creation
usage. Cache creation is not conflated with uncached input. Unknown cache fields
remain absent; mixed known/unknown cache totals are flagged incomplete. This is
usage normalization, **not** a new native Anthropic request-protocol adapter.

Provider results keep the last request's `usage` for calibration and expose
`attemptUsage` separately for observed usage across retries. Main/child totals
include reported failed-attempt usage. Unreported usage cannot be reconstructed.
The raw usage is present in the terminal provider-attempt event; the summary
contains normalized counters, not a guessed monetary price.

### Context preservation and result retention

Both core and wrapper use the existing stable-tail retrieval implementation.
Unchanged retrieval content is not rewritten; obsolete optional knowledge is
removed. Tool schemas are sorted deterministically in a compiler that does not
mutate caller messages or elevate retrieved data to user authority.

Failure checkpoints now retain bounded stdout/stderr diagnostics, call identity,
file hashes, read ranges, timeout flags and full-result references. Head and tail
are retained for long diagnostic text. Pinned current-task requirements and
complete tool-call/result groups remain protected.

Large native results (16,000–1,000,000 JSON characters) can be retained in the
existing **task-owned durable evidence store**, deduplicated over a bounded
128-entry reference map. The existing `mcp_read_result` pager reads native or MCP
JSON without invoking a remote MCP server or repeating the original operation.
Before removing history, compaction can prune old output with a valid full-result
reference, preserving diagnostic summaries and the pager reference. Recent eight
messages are not pruned by that first stage. The ordinary checkpoint path remains
available when pruning is insufficient. Failed compaction does not modify the
input conversation in place.

Native-result archiving is deliberately conditional on a real durable store and
is not enabled for isolated Builder tool sets. Direct test/SDK calls without
TaskRuntime keep their previous in-memory behavior. No arbitrary filesystem path
is accepted by the result pager. Existing run-evidence byte quotas still apply;
this PR does not create unlimited output retention or a new garbage collector.

### Tool scheduling

The concurrency limit remains **4**. The improvement is scheduling granularity:
maximal consecutive parallel-safe calls run in a pool; writes, unknown calls and
session/control operations remain barriers. Main and child loops share the same
planner and executor. Existing role, scope, approval and durable checks run for
every tool as before.

Results enter the conversation in model-declared order. A failed or cancelled
pool stops new admissions and joins all started workers before phase cleanup.
This is not forced termination of arbitrary remote side effects; uncertain
operations retain the existing recovery semantics.

### Inference recovery and retries

`loop-recovery.js` wraps **inference only**, not a tool batch:

- Context overflow permits at most two repairs for one completion request. Each
  repair must produce a strictly smaller model-visible request within a reduced
  input budget. An unshrinkable pinned request stops with an explicit budget error.
- A terminated, text-only output-limit response may continue once. The first part
  is kept in the conversation and combined with the final text-only continuation.
  Truncated responses containing tool calls are never executed or auto-continued.
- A fully terminated malformed tool-call response permits one correction request;
  none of the invalid response's calls execute. Duplicate IDs are invalid too.
- Guidance is checked before the next repaired request. Cancellation propagates.
- There is at most one shared output/protocol correction in addition to the two
  context repairs per invocation. Exhaustion fails explicitly rather than looping.

The provider honors numeric/date `Retry-After` and `retry-after-ms`, uses positive
bounded jitter, and retains the existing maximum attempt counts. A server wait
longer than the 120-second automatic wait budget is deferred, not shortened and
ignored. Quota/auth/context/protocol problems are not generic transport retries.
No automatic model fallback, credential changes or unsafe side-effect replay is
introduced. Side chat benefits from provider retry classification/metrics but is
not converted into a new agent loop with completion-policy enforcement.

### Progress and completion policies

The progress guard removes volatile **result** metadata (including result refs)
from evidence comparisons but does not remove meaningful request arguments,
file hashes, read cursors or output. Warnings escalate to explicit replanning
advice. A quiet valid process gets polling guidance; it is not hard-stopped solely
for being quiet. This PR does not add an OS process wait primitive.

Defaults remain advisory and agent-led. Advanced callers may supply:

```js
loopPolicy: {
  maxRepeatedEvidence: 6,             // 0 (default) disables the hard threshold
  requireVerifiedChanges: true,       // false by default
  maxCompletionContinuations: 1       // 0..3; default 1
}
```

The hard repeated-evidence threshold applies at the main loop's next model
boundary, not in the middle of a tool operation. New user guidance resets it.
Child loops retain their existing round budgets and advisory guards.

The optional completion policy consults current-version verification evidence
and the latest workspace snapshot; it does not run scripts or Review itself.
After a bounded opportunity to produce required evidence, delivery is marked
`partial` with preserved changes, not falsely `completed`. Existing explicitly
recognized user verification waivers and non-completed outcome states are
respected. These options are per invocation and exposed through the existing
request path; no new settings UI or persisted cross-run policy editor is added.
No arbitrary executable hooks are loaded from the project.

### Diagnostics

`loopMetrics` records request/attempt counts, provider time, summed tool time,
retry waits requested, observed usage, compactions, recovery attempts and progress
warnings. Tool time is a sum and can exceed elapsed wall-clock time under
parallelism. Prefix comparisons are capped and are **not** provider cache hits.
Main and child metrics are scoped; do not add already-aggregated usage twice.
The diagnostic object does not store prompt text, tool arguments, source content,
credentials, or hidden reasoning. Actual task events remain subject to the
existing event-store policy.

## Verification and quantitative interpretation

Before changes, the existing deterministic audit gate passed **46/46 scripts**
on local Node 22.16.0/Linux. Three new production-module test files are now added
to that gate and to `npm run test:harness-loop`:

| Suite | Coverage |
| --- | --- |
| `harness-loop-unit.mjs` | Calibration, usage semantics, stable retrieval, diagnostic retention, protocol grouping, barrier ordering, cancellation/drain, progress and completion policies, metrics privacy |
| `harness-loop-provider.mjs` | Retry-After, quota, cancellation, effective context reduction, bounded partial continuation, malformed and duplicate calls, guidance during repair |
| `harness-loop-integration.mjs` | Actual main/child loop entry points with simulated providers, real file reads/writes and denials, opted-in budgets, honest partial delivery, task-owned SQLite evidence paging |

Run:

```sh
npm run test:harness-loop
npm run test:audit-suite
npm run build
```

Detailed JSON results are written under `.tmp/audit-results/` and are included in
the existing cross-platform audit workflow artifacts. The normal CI also runs
the dedicated loop gate. Existing behavioral regression coverage was retained. The provider retry test
now filters retry events because terminal attempt metrics are intentional new
events. An extra agent-led image test failed on unchanged baseline main too:
the fixed prompt/tool catalog produced 21,295 estimated tokens, exceeding its
obsolete 20,000 absolute cutoff. It now compares otherwise-equivalent 300 KB and
3 MB encoded image inputs (difference below 64 estimated tokens), preserving a
strong check against counting Base64 as text. This additional existing suite is
also promoted into the required audit gate.

Quantitative checks are **not** paid-model benchmarks:

- Re-estimating an unchanged calibrated fixture has zero token discrepancy with
  the injected usage. This does not establish real-provider tokenizer accuracy.
- Eight equal-duration operations `read ×4 -> write -> read ×3` have a theoretical
  critical path of three units instead of eight. The 62.5% difference is a
  scheduling calculation, not measured end-to-end speedup. The integration test
  separately verifies actual old/new file contents and receipt ordering.
- An explicitly configured six-repeat budget blocks before a seventh model
  request in the repeated-read fixture. The default stays advisory.
- Simulated context-overflow tests inspect actual before/after request sizes and
  check pinned task constraints. Simulated partial-output and invalid-call tests
  check the bounded request counts and absence of invalid tool side effects.

The PR checks and uploaded JSON reports are the source for final environment-
specific pass/fail results. Do not infer an unobserved Windows/package result
from the local run alone.

## Deferred / not claimed

No real-model pass-rate, cache-hit percentage, token-cost saving or wall-clock
improvement is claimed. Those require paired tasks using the same model,
permissions, repository snapshot and budget, followed by per-component ablations.
No model-driven semantic summarizer, embedding index, native AppContainer,
independent supervised Core, Office pixel-level QA or release signing is included.
Those are separate workstreams, not implied by passing loop unit tests.

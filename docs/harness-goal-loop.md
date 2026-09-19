# Goal-oriented Harness upgrade

Baseline: PR #63 head `4abca36b1e760117d554f053b0c232981a45dbf1` (package 0.9.8).
This is a **stacked change**: merge #63 first, then retarget this PR to `main`.
No version/dependency bump, release, automatic merge, provider failover, new tool
permission or executable project hook is introduced.

## Architecture

```
existing TaskRuntime / durable run context / permissions / evidence
  -> main or child loop
     -> active human constraints (original inputs pinned until explicit reset)
     -> TaskBrief projection (versioned assertions + provenance)
     -> optional bounded public-decision summary before compaction
     -> immutable configured TaskAcceptance predicates
     -> existing request compiler -> explicit native protocol codec
     -> existing permission + durable tool execution
        -> process event wait (output / exit / timeout / steering / cancel)
        -> observed receipts, cross-version failure/oscillation detection
     -> fresh diagnosis + different public hypothesis when replan is required
     -> honest per-requirement report and completed / partial / blocked outcome
```

## 1. Decisions survive long tasks

`task_brief` is a bounded projection persisted with the **existing** main/worker
context; it is not a second task database. The runtime records original human
source hashes and observed tool receipts. Model-written decisions, rejected
approaches and questions are always labeled assertions, not user instructions or
verification passes. Updates use an expected revision; superseding a decision
retains its history. Invented tool IDs are rejected. Resumed evidence is historical.
A fresh turn can inherit the same task/workspace-owned projection, not another
task's brief. Original active human messages are pinned even if they predate the
pinning metadata; only an explicit human reset revokes them.

At context pressure, an optional same-provider summary examines at most 12 old
**public assistant updates**, 12,000 characters total. The output is bounded to
2,048 tokens and eight entries. Each must quote an exact named source substring.
This validates provenance, **not semantic correctness**. Invalid output leaves
existing decisions unchanged. Cancellation/new guidance prevents stale submission.
The attempt is persisted before the request and its usage is included. No hidden
reasoning is summarized, no tools are executed and no second provider is used.

Limits: 64 records, 180K serialized snapshot; active injected decisions have a
14K-character budget and explicitly report omissions. The complete record remains
available through `task_brief(read)` and the persisted result. Full capacity is an
explicit error, not silent eviction. `loopPolicy.maxBriefSummaries` is 0–2,
default 1; recovered attempts remain counted. This is not unlimited semantic
memory, a vector index or a guarantee that a model will never forget.

## 2. Requirements have explicit acceptance predicates

The client may supply `taskContract`, or a workspace can define
`.aporiax/acceptance.json`. The task settings panel validates JSON with the same
pure schema used by the backend. Empty selection uses the workspace file;
`taskContract: null` explicitly disables it. Configuration is captured once for
an invocation, persisted on recovery and **cannot be rewritten by the model**.
Worker/planner scopes do not inherit the entire parent's acceptance obligation.
Final Main checks the integrated task.

Example:

```json
{
  "version": 1,
  "enforce": true,
  "requirements": [
    {"id":"docs","text":"Document the new behavior","checks":[
      {"type":"file_contains","path":"README.md","text":"Recovery"}
    ]},
    {"id":"config","text":"Enable the expected setting","checks":[
      {"type":"json_value","path":"config.json","keys":["enabled"],"equals":true}
    ]},
    {"id":"regression","text":"Tests pass against current implementation","checks":[
      {"type":"command_exit","command":"npm test","cwd":".","inputs":["package.json","src/main.js"]}
    ]},
    {"id":"usability","text":"A human confirms the intended interaction","checks":[]}
  ]
}
```

Supported checks: `file_exists`, literal `file_contains`, `json_value`, and an
exact `command_exit` receipt. The evaluator only reads bounded workspace files
through existing path/read permissions. It **never starts commands**. Command
checks must be executed by the ordinary authorized tool path; they need exit 0
and unchanged hashes for the explicitly declared inputs before/after the command
and at delivery. A resumed run must revalidate commands. Modified or inaccessible
inputs, missing receipts, nonzero exits and skipped calls do not pass.

The declared inputs are **not automatic transitive dependency discovery**.
They must include relevant source/configuration. An exit code does not prove the
full specification. Empty checks are `needs-human-review`, never a fabricated
pass. Natural-language requirements are not automatically converted into trusted
checks: users must configure important predicates; omitted semantics remain
unverified. A bounded continuation uses the existing allowed tools; exhausted
acceptance yields `partial` with changes preserved. `enforce:false` reports without
veto. No untrusted shell hooks or model-written pass receipts are accepted.

Limits: 32 requirements, eight checks each, 64K contract; bounded 8 MiB files.
The UI shows each row, observed evidence and the configured-only scope.

## 3. Waiting uses process events, not model polling

`wait_process` shares the existing per-task process manager. It waits for output
past a cursor or process exit, with a 0–120,000 ms bound. Output, exit, stopping,
shutdown, steering and cancellation wake listeners; subscribe-then-recheck closes
the output-before-subscribe race. At most 32 waiters per process are accepted;
timers/listeners are removed on every exit path. Quiet processes are not killed
or classified as failed just for being quiet. Output cursor expiry remains visible.

The process continues under the existing execution backend and permission rules.
This adds neither an OS sandbox nor persistent processes to Isolated mode. It is
process event waiting, not a new universal agent/approval event scheduler. The
integration fixture needs three model requests (start, wait, delivery), zero
`read_process` polling calls, and checks actual local process output and exit.
This is a deterministic fixture, not a latency/cost claim for arbitrary tasks.

## 4. Repeated failures require a different evidence-backed attempt

`StrategyHistory` recognizes three same-command/same-diagnostic failures across
workspace versions, and an A/B/A/B file-content oscillation. While a replan is
pending, new mutations/commands/delegation are blocked, but existing approved
diagnostic reads and safe task controls remain available. `replan_strategy`
requires a different concise public hypothesis and newly observed diagnostic
call IDs. Old evidence or volatile timestamps/result references alone do not
qualify. The hypothesis remains an assertion, not a proof or permission grant.

Main and child sessions retain this state during recovery. Intervention budget
`maxStrategyInterventions` is 0–4 (default 2). Exhaustion preserves work and reports
a blocked/failed outcome, not an endless retry. New human guidance can reset the
strategy. This is bounded pattern recognition, not a claim to understand whether
any paraphrased hypothesis is truly novel. Existing repeated-evidence and child
round budgets still apply. No uncertain external side effect is replayed merely
to gather output.

## 5. Explicit native protocol adapters

The network-boundary codec supports:

| Profile | Endpoint | Authentication / continuation |
| --- | --- | --- |
| Compatible Chat (old default) | `/chat/completions` | Bearer; preserves existing profile behavior |
| DeepSeek native Chat | `/chat/completions` | Bearer; preserves `reasoning_content` in tool continuation |
| OpenAI Responses | `/responses` | Bearer; flattened function schemas; `store:false`; encrypted reasoning continuation |
| Anthropic Messages | `/messages` | `x-api-key`, `anthropic-version`; native images/tool blocks, signed thinking |

Provider settings now expose protocol, native output limit and Anthropic
adaptive/manual thinking choice. Existing profiles stay compatible until edited;
new provider presets explicitly select the indicated native profile. No fallback
changes destination, credentials or model. Model discovery uses the chosen auth
protocol. The managed Aporia Cloud route remains unchanged.

Native streams normalize into the existing completeness/retry loop. Tools are
released only after a terminal event and still undergo existing schema, duplicate
ID, scope and approval checks. Standard text/image/function blocks are supported;
unrecognized server-tool/beta output fails explicitly. Stream/event byte limits
remain bounded. A valid terminal event completes without waiting for an open
socket to close. Cancellation propagates to the chosen request.

Native signed/encrypted continuation is private protocol state bound to provider
ID, endpoint, model, protocol and the unmodified public assistant message. It is
kept only in the existing durable conversation and is not rendered in task result
cards, provider delta events or loop diagnostics. It cannot be silently sent to a
different provider/model. Text-only output-limit recovery keeps original signed
messages rather than attaching old signatures to combined display text. Opaque
encoded data uses conservative usage-based token accounting, not character-count
billing estimates. Cross-question side chat keeps public history; native opaque
state is retained within its tool exchange, not transplanted between profiles.

Adaptive and manual thinking are explicit choices, **not model guesses or an
automatic downgrade mechanism**. Manual budget must be less than output budget.
Unsupported models/options fail through the existing provider error path. This is
native request/stream/function support, not feature parity with every hosted tool
or provider beta. No real API key, paid model request, OAuth subscription or live
model benchmark was used in this change.

Primary protocol references (reviewed 2026-09-19):
- https://api-docs.deepseek.com/guides/thinking_mode
- https://platform.claude.com/docs/en/build-with-claude/streaming
- https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- https://platform.openai.com/docs/guides/function-calling
- https://platform.openai.com/docs/guides/reasoning

## Verification

```
npm run test:goal-loop
npm run test:audit-suite
npm run test:goal-ui
npm run build
```

Four portable suites cover brief/acceptance, real process waiting/strategy,
native streams, and actual main/child/SQLite integration. They are required by the
audit runner and ordinary CI. The real Chromium/Edge settings/report fixture is
also part of the Windows desktop gate; screenshots and result JSON are retained.
Fixtures are explicit `.invalid` endpoints and never use real credentials.

Test environment results must be read from final-head Actions artifacts. Local
Linux Chromium was prevented from navigating localhost by an environment policy;
that is **not** a passed UI test. The Windows gate is the UI source of truth.
One existing six-worktree test now prints the actual rejection reason instead of
serializing Error as `{}`; its acceptance assertion is unchanged. Original loop,
recovery, permission and storage regressions remain enabled.

Not claimed: real-world success-rate, money saved, production installation/upgrade
acceptance, complete natural-language requirement extraction, universal autonomous
replanning, native OS isolation, independent Core or release readiness.

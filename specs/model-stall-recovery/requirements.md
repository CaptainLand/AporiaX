# Model stall recovery requirements

Status: confirmed by the operator on 2026-10-22; local implementation authorized.

## Scope

Detect model streams that retain transport activity but stop producing useful
output. Attempt recovery without replaying tools or silently creating duplicate
paid inference. After three unsuccessful recovery attempts, preserve the task
and ask for user action in Witness instead of failing or stopping the run.

## User story

As a user, I want AporiaX to attempt recovery from model connection stalls and
retain my work, so a temporary upstream problem does not end the whole task.

## Acceptance criteria

1. While receiving model responses, when nonempty text, reasoning or tool
   argument data advances, the system shall update the effective-progress clock.
   Heartbeats, empty events, repeated state and UI token estimates alone shall
   not reset this clock. Reasoning text shall not be exposed to the UI.
2. When a response has no effective progress for the configured warning
   interval, Witness shall distinguish an active connection with no new content
   from a disconnected connection. Queueing and waiting for the first output
   shall be distinguished from a stall after generation has begun. There shall
   be no fixed maximum duration for a request that continues making progress.
3. When a stall requires recovery, the system shall attempt at most three
   recovery operations per stall episode, with visible attempt counts. Mere
   transport heartbeats shall not reset this attempt budget.
4. When a recovery attempt encounters an uncertain dispatched request, the
   system shall preserve its request identity and first query any available
   status/replay capability. A connection check shall not be presented as a
   successful output reconnection. The system shall not silently create another
   billable generation, switch models, or assume that cancelling locally stops
   upstream generation or billing.
5. When all three recovery attempts fail, the task shall remain nonterminal in
   an explicit awaiting-user-recovery state. Witness shall explain that work is
   retained and the user may retry recovery, explicitly start a new inference,
   continue waiting, or stop. This condition shall not emit run.failed,
   run.finished, a generic interrupted final reply, or an automatic stop.
6. While the original stream remains usable and the user has not stopped or
   superseded it, when valid output resumes or the original response completes,
   the system shall accept it, clear the recovery warning, and continue the
   same task. A stale original response shall never execute tools after a
   replacement request has been explicitly selected.
7. When recovery is needed, the system shall preserve received text,
   confirmed tool results and file changes. Incomplete tool-call arguments shall
   never execute or be spliced together across generation attempts. Recovery
   shall not replay the whole task or previously confirmed side effects.
8. When the user explicitly stops the task, the system shall cancel recovery
   timers/waits and prevent late results or network events from restarting it.
   Recovery shall respect independent user/sleep/network pause reasons.
9. When state is checkpointed or restored, the system shall retain partial
   output, original request identity and exhausted recovery budget without
   silently granting another automatic retry cycle or paid inference.
10. Tests shall cover heartbeat-only streams, increasing output, reasoning and
    argument streams, three failed recoveries, late original-stream recovery,
    explicit user stop, unknown billing state, and prevention of repeated tools.

## Proposed defaults for confirmation

- Begin recovery after 180 seconds without effective model data, including
  before first output. Thinking duration alone is never a trigger.
- At most three recovery checks; after the third, keep a usable original
  stream open indefinitely. Do not launch a fourth check automatically.
- A disconnected stream waits for explicit user action without ending the task.
- No new paid inference without a confirmed safe-retry contract or explicit
  user authorization. Raw-stream replay requires backend support; it is not
  assumed to exist on arbitrary user-provided APIs.

## Non-goals

- No deployment or installed-client replacement in this change.
- No quota bypass, fabricated settlement, automatic model switching, global
  retry loops or relaxation of tool approval/sandbox rules.
- Unrelated authentication, quota and storage failures are not relabelled as
  successfully recovered model responses.

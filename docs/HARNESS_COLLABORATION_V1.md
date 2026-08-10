# AporiaX Harness Collaboration v1

Collaboration v1 adds semantic coordination on top of the existing physical isolation guarantees in Harness v2.

Harness v2 already prevents two Builders from silently overwriting one another through Agent budgets, explicit scope leases, isolated Git worktrees, baseline conflict checks, and conflict-checked merge. Collaboration v1 addresses a different class of failure: two Builders can edit different files successfully and still disagree about UI conventions, API fields, schema names, state ownership, or security assumptions.

## Design goals

The collaboration layer follows four rules:

1. One Lead/Main remains the final decision authority.
2. Builders share an explicit contract instead of relying on free-form peer conversation.
3. Coordination must remain bounded so a simple task does not turn into an expensive Agent meeting.
4. Review, Verify, and Witness evaluate the same contract that Builders received.

The resulting flow is:

```text
Adaptive Agent Budget
        |
        v
Builder Preflight / Lead Plan
        |
        v
Shared Collaboration Contract
        |
        v
Deterministic Plan Approval
        |
        v
Task Graph + Scheduler
      /     \
     v       v
Builder A   Builder B
Worktree A  Worktree B
     |       |
Structured Handoffs
     \       /
      v     v
Semantic Contract Check
        |
        v
Conflict-checked Merge
        |
        v
Lead/Main Integration
        |
        +---- Review
        +---- Verify
        |
        v
Witness Audit + Anchor
```

## Shared Collaboration Contract

The preflight planner now returns both Builder tasks and a shared contract. The contract is deliberately small and contains only decisions that must remain consistent across workers.

Example:

```json
{
  "title": "Authentication integration contract",
  "goal": "Login and registration behave like one feature",
  "invariants": [
    {
      "key": "auth.identifier",
      "category": "api",
      "value": "identifier:string",
      "severity": "must"
    },
    {
      "key": "auth.form-style",
      "category": "ui",
      "value": "reuse existing AuthForm/Input/Button styling",
      "severity": "must"
    }
  ],
  "sharedFiles": [
    "src/stores/auth.ts",
    "src/router/index.ts"
  ],
  "acceptance": [
    "Login and registration use the same auth field naming"
  ]
}
```

Supported invariant categories are `ui`, `api`, `schema`, `state`, `security`, `testing`, and `general`. Invariants may be `must` or `should`.

The contract also records Builder ownership from each task's write scopes. Shared files belong to Lead/Main and must not be placed inside a Builder lease.

## Plan Approval without another model call

Each proposed Builder task declares:

- explicit `writeScopes`;
- dependencies;
- `contractKeys` it must obey;
- one concise `approvedPlan` with approach and assumptions.

`approveBuilderPlan()` validates this locally and deterministically. It does not spend an extra LLM request.

The approval rejects unsafe plans when, for example:

- parallel Builders have no shared invariants;
- a Builder has no explicit write scope;
- a Builder scope owns a Main-owned shared file;
- a task references an unknown contract key or dependency.

Existing scope-overlap validation remains in force before this layer.

If approval fails, Builder parallelization is declined and the normal Lead/Main runtime handles the task instead.

## Bounded Mailbox

Collaboration v1 has a structured, bounded mailbox with only three message types:

- `question` — a decision or ambiguity needs another actor's attention;
- `notice` — a concise coordination fact;
- `blocker` — work cannot safely continue without coordination.

Mailbox message count and total serialized size are bounded. This prevents unbounded Agent chatter from becoming a hidden token sink.

This version intentionally does **not** implement arbitrary live peer-to-peer interruption while two independent Builders are already running. `livePeerInterrupts` remains `false`.

Messages are useful in two places:

1. a Builder that depends on an earlier Builder receives relevant mailbox items before it starts;
2. Lead/Main receives unresolved messages during integration.

This gives the system a controlled coordination channel without turning every Builder task into a group chat.

## Structured Builder Handoff

A Builder must finish with one JSON handoff:

```json
{
  "summary": "Implemented login flow",
  "assumptions": [
    "Lead owns changes to the shared auth store"
  ],
  "requiresMain": [
    "Wire the shared route"
  ],
  "contractAssertions": [
    {
      "key": "auth.identifier",
      "value": "identifier:string",
      "evidence": "src/features/login/LoginForm.tsx"
    }
  ],
  "messages": [
    {
      "type": "notice",
      "to": "main",
      "topic": "auth-field",
      "detail": "Login uses the canonical identifier field",
      "blocking": false
    }
  ]
}
```

The Harness compares declared assertions against the authoritative contract. An explicit contradiction is rejected before that Builder worktree is merged into the real workspace.

After all Builder waves finish, `compareBuilderHandoffs()` also detects disagreement between Builders that asserted different values for the same contract key.

Missing assertions and unstructured handoffs are warnings rather than automatic proof of failure. The semantic checker only validates claims the Harness can normalize; it does not pretend to understand every semantic property of arbitrary source code.

## Review and Verify use the same contract

The shared contract is injected through an AsyncLocalStorage collaboration context in `agent-context.js`.

`loadProjectInstructionContext()` appends the collaboration contract to the normal project instructions for the lifetime of the relevant run. The existing Lead/Main runtime and its existing Review / Verify / Explore / Curator subagents already load that project instruction context, so they receive the same contract without duplicating or rewriting the legacy runtime.

This changes the quality question from:

> Does this file look locally correct?

into:

> Does the current implementation satisfy the same cross-worker contract that the Builders were told to implement?

The normal version-matched progressive Review and Verify evidence rules remain unchanged.

## Witness collaboration audit

The orchestration Witness is wrapped with a lightweight collaboration audit. Its snapshot now includes:

- the shared contract;
- Plan Approval result;
- bounded mailbox history;
- semantic handoff check;
- collaboration violations/conflicts.

Witness remains observational. It does not edit files or override Main. Runtime/Main/Scheduler remain responsible for corrective actions.

## Cost model

This collaboration layer does not change the core cost rule from Harness v2:

- simple/direct tasks do not get Builder orchestration;
- read/light/standard tasks do not automatically pay for two Builders;
- only Builder-eligible large write tasks pay for the orchestration planner and Builder workers;
- Plan Approval and semantic handoff comparison are deterministic local code, not model calls;
- mailbox traffic is bounded and is not implemented as continuous Agent-to-Agent chat.

## Hard guarantees vs semantic guidance

Hard runtime guarantees include:

- Builder count budget;
- non-overlapping write scopes;
- separate worktrees;
- out-of-scope edit rejection;
- baseline conflict checks before merge;
- Main-owned shared file rejection during Plan Approval;
- explicit Builder contract contradiction rejection before merge.

Semantic guidance/evidence includes:

- planner-created contract quality;
- whether a Builder accurately reports every semantic choice in its handoff;
- Review/Verify interpretation of UI/API/schema intent.

This is why Lead/Main still re-reads merged Builder output and why Review/Verify remain part of the final evidence pipeline.

## Current limitations

- `livePeerInterrupts` is intentionally `false`; independent Builders do not run an open-ended live group chat.
- Mailbox items emitted by a Builder handoff are advisory until integration; Lead must consider the Builder's final status when consuming them.
- Contract quality depends on the preflight planner identifying the right cross-cutting invariants.
- Semantic comparison checks normalized handoff assertions; it cannot statically prove every contract rule from arbitrary code.
- Explore / Review / Verify / Curator still execute through the compatibility runtime internally, even though they inherit the new shared contract.
- Core HTTP `taskRpc` remains `false`; desktop runtime still owns credentials, approvals, pause/resume, steering, and mutation control.

## Validation

Run:

```text
npm run test:collaboration
npm run test:harness-v2
npm run test:architecture
npm run test:cache
npm run test:runtime
npm run build
npm start
```

`test:collaboration` covers contract normalization, deterministic Plan Approval, shared-file ownership rejection, bounded mailbox routing, structured handoffs, cross-Builder semantic disagreement detection, Witness audit state, and collaboration-context injection.

`test:harness-v2` additionally runs the existing v2 safety smoke and the end-to-end deterministic orchestration smoke, including planner contract creation, two isolated Builders, handoffs, semantic comparison, Lead integration, and final workspace changes without making paid/network model calls.

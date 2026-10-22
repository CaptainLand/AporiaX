# Local implementation

- [x] 1. Add effective-data watchdog, bounded receipt checks and durable state.
  - Requirements 1–4, 6, 8–9.
- [x] 2. Integrate model streams and nonterminal disconnected recovery waits.
  - Requirements 3–9.
- [x] 3. Present honest recovery states in existing Witness UI.
  - Requirements 2, 5–6.
- [x] 4. Run regression tests, browser verification and capture screenshots.
  - Requirement 10. No production request or publication.

## Verification

- `test:model-recovery`: 11 synthetic runtime cases plus real Witness browser
  checks, dark/light and narrow-screen screenshots. Keepalive-only stalls,
  growing reasoning/arguments/authoritative output counters, native adapters,
  late original answers, disconnected nonterminal waiting, explicit stop,
  persisted exhaustion and contradictory billing receipts are covered.
- Passed `test:task-efficiency`, `test:suspension`, `test:task-ending`,
  `test:provider-stream`, `test:gpt-compat`, `test:context-reliability`,
  `test:harness-loop` and `test:cloud-compat` during implementation.
- Production frontend and control bridge build passed; existing large-chunk
  size advisory remains. No new dependencies or version bump.
- Screenshots: `.tmp/model-recovery-qa/checking-dark.png` and
  `.tmp/model-recovery-qa/waiting-third-dark.png`, plus light/narrow/closed
  variants. These are controlled local fault simulations using the actual UI,
  not screenshots of a live user's request or proof of upstream availability.
- Not packaged or published; installed AporiaX was not replaced or restarted.

---
name: test-strategy
title: Test Strategy
description: Select high-value tests around changed behavior, boundaries, failure modes, and regressions.
version: 1.0.0
auto: true
triggers: [test, verify, regression, coverage, qa, 测试, 验证, 回归]
tools: [read_file, search_text, run_command]
---

Design verification in proportion to the risk of the change.

1. Map changed behavior to user-visible outcomes and likely failure boundaries.
2. Prefer deterministic, focused checks before broad suites.
3. Cover the happy path, one meaningful boundary, and the repaired regression.
4. Never claim a check passed unless its command or artifact was actually inspected.
5. Separate code defects from environment, dependency, or unavailable-service failures.

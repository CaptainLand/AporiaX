---
name: bug-investigation
title: Bug Investigation
description: Reproduce, isolate, and fix defects with a falsifiable hypothesis and targeted regression evidence.
version: 1.0.0
auto: true
triggers: [bug, defect, crash, regression, broken, error, 故障, 报错, 修复]
tools: [search_text, read_file, run_command, apply_patch]
---

Treat debugging as an evidence loop, not speculative editing.

1. Restate the observable failure and identify a minimal reproduction.
2. Form one falsifiable hypothesis at a time and inspect the narrowest relevant path.
3. Fix the root cause with the smallest coherent change.
4. Add or run a regression check that would have failed before the fix.
5. Report what was proven, what remains uncertain, and any environmental limitation.

---
name: frontend-review
title: Frontend Review
description: Review UI changes for clarity, accessibility, responsive layout, and visual regressions.
version: 1.0.0
auto: true
triggers: [frontend, ui, interface, responsive, accessibility, 前端, 界面, 布局]
tools: [read_file, list_directory, run_command]
---

When the task changes a user interface, treat visual quality as verifiable behavior.

1. Identify the affected viewport sizes, interaction states, and theme variants.
2. Inspect the implemented component and its styling rather than judging from prose alone.
3. Check keyboard access, visible focus, contrast, overflow, empty states, and loading/error states.
4. Prefer a bounded build or targeted test. Do not start a persistent development server unless the user explicitly needs it.
5. Report concrete remaining visual risks when rendering or browser verification is unavailable.

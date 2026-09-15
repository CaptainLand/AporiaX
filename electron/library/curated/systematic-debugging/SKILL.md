---
name: systematic-debugging
title: 证据驱动排障
description: Trace a reproducible failure to its root cause with focused evidence and a scoped regression check.
license: MIT
version: "1.0.0"
auto: false
tools: [read_skill_resource, read_file, search_text, run_command]
metadata:
  author: AporiaX
  adapted_from: obra/superpowers
---
# Systematic debugging — scoped AporiaX adapter
Use when explicitly selected for a bug investigation. Read
references/root-cause-tracing.md for upstream diagnostic techniques.
The upstream full workflow is retained at references/upstream-skill.md for
reference, not as a global policy. Do not import its hooks or start subagents
unless the user's task and available host tools permit that.
Inspect the exact error and relevant changes; reproduce if feasible; state a
testable cause and make the smallest adequate fix. Validate against the relevant
failure, not unrelated project tests. Distinguish a proposed fix from verified
behavior. Honor diagnosis-only requests and user choices to skip testing.

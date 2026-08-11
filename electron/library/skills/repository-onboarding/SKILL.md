---
name: repository-onboarding
title: Repository Onboarding
description: Build a concise, evidence-backed mental model of an unfamiliar repository before making changes.
version: 1.0.0
auto: true
triggers: [repository, architecture, codebase, onboarding, unfamiliar, 仓库, 架构, 项目理解]
tools: [list_directory, search_text, read_file]
---

When entering an unfamiliar repository, establish orientation before editing.

1. Locate project rules, manifests, entry points, tests, and build commands.
2. Trace the smallest relevant execution path instead of reading the whole repository.
3. Record architectural claims with file evidence and distinguish facts from inference.
4. Reuse Project Understanding when it is current; update it only with durable knowledge.
5. End with the affected modules, constraints, and the safest next action.

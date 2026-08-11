---
name: release-readiness
title: Release Readiness
description: Validate tests, build artifacts, versioning, and handoff evidence before a release.
version: 1.0.0
auto: true
triggers: [release, publish, package, build, 发布, 打包, 构建, 版本]
tools: [read_file, list_directory, git_status, git_diff, run_command]
---

For release work, build a short evidence-backed checklist before claiming completion.

1. Confirm the intended version and release target.
2. Inspect repository state and preserve unrelated user changes.
3. Run the smallest relevant tests before the production build.
4. Verify that expected artifacts exist and identify their exact paths.
5. Distinguish local build completion from GitHub publication, signing, and distribution.
6. Never leave persistent servers or watchers running as release verification.

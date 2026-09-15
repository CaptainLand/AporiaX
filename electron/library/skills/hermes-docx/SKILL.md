---
name: hermes-docx
title: Word 编辑与模板填充（Hermes）
description: >
  Edit existing DOCX documents, fill placeholders, inspect revisions and comments
  using the bundled Hermes Python scripts. Install this package from the Library
  into the user Skill directory before executing helpers.
license: MIT
version: "1.1.0-aporiax.1"
auto: false
compatibility: Python 3.10+ and python-docx (lxml); package must be installed outside app.asar. No model-specific API required.
tools: [read_skill_resource, run_command, inspect_office_file]
metadata:
  author: Nous Research; AporiaX adapter
  runtime: python
  requirements: [python>=3.10, python-docx]
---
# Hermes DOCX — AporiaX adapter
The bundled scripts and upstream instructions are MIT-licensed Nous Research
sources pinned in the upstream lock manifest. This wrapper adapts their invocation
to AporiaX without installing the Hermes Agent or requiring its models.

Before use, read references/upstream-skill.md in full with read_skill_resource.
All scripts/ paths in that reference mean THIS PACKAGE ROOT, not references/
and not the user's workspace. Use an absolute quoted script path in run_command.
If the root contains app.asar, install the package from Extensions Library first.
Check the chosen Python interpreter can import docx; do not claim readiness
without checking. If missing, report the dependency; install only within the
user-authorized task. Do not auto-run setup on import or discovery.

Use an explicit output path in the task workspace. Preserve originals:
for commands that edit in place by default, supply -o with a new output path.
Never accept/reject revisions or delete comments unless the user requested it.
Script subprocesses have normal host command permissions; this is not an OS
sandbox. Do not treat an upstream allowed-tools field as extra authorization.

Read back the produced document; package health checks are not visual validation.
Only a rendered final file can support pagination/visual claims. If rendering
is unavailable or skipped, deliver with that limitation; do not block the whole
task, invoke unrelated tests, or fabricate success.

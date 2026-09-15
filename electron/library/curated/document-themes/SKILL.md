---
name: document-themes
title: 文档配色与字体主题
description: Apply restrained typography and color themes to documents or presentations on explicit request.
license: Apache-2.0
version: "1.0.0"
auto: false
tools: [read_skill_resource]
metadata:
  author: AporiaX
  adapted_from: anthropics/skills/theme-factory
---
# Document themes — AporiaX adapter
Read one appropriate themes/ file with read_skill_resource:
modern-minimalist.md, ocean-depths.md or arctic-frost.md.
These theme references are from Anthropic theme-factory under Apache-2.0;
this adapter does not include or depend on their proprietary DOCX Skill.
Respect an existing user template. Unless the user wants to choose, use a
restrained suitable theme without interrupting them with a mandatory theme picker.
Fonts listed in references are suggestions, not bundled assets or proof they are
installed. Provide a compatible CJK font for Chinese text and use the document
tool's actual supported options. Do not promise that a theme alone fixes layout.

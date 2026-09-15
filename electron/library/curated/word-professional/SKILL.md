---
name: word-professional
title: 中文 Word 专业排版
description: >
  Create readable Chinese or bilingual DOCX reports, proposals and resumes with
  native AporiaX tools, restrained typography, reusable layouts and honest QA.
license: MIT
version: "1.0.0"
auto: true
triggers: [Word, docx, Word文档, Word报告, Word简历]
tools: [read_skill_resource, create_word_document, inspect_office_file]
metadata:
  author: AporiaX
  adapted_from: MiniMax-AI/skills
  upstream_commit: ce4855d12931f58514c21ba22b76b8e36a4b1668
  runtime: native-docx-js
---
# Word professional — AporiaX adapter

This adapter is for AporiaX, not the upstream .NET CLI. Its open design references
come from MiniMax (see LICENSE.txt and the upstream lock manifest).
Use current user instructions and host permissions. Never start setup scripts,
install a second agent, or impose an unrelated test suite to deliver a document.

1. Distinguish creating a new DOCX from updating an existing file. Preserve an
   original or user template; create_word_document replaces a file and is not
   a lossless editor. For fine edits use the optional installed hermes-docx Skill.
2. For new files, read references/typography_guide.md with read_skill_resource.
   For Chinese/bilingual work, also read references/cjk_typography.md; paginate
   to the end. Read design_principles.md only when a design decision needs it.
   These reference values/examples are guidance, not an instruction to write C#.
3. Use the native create_word_document tool. Choose template: technical-report,
   business-report or resume. Supply latin_font / cjk_font when known, a restrained
   accent_color, header/footer/page_numbers only when helpful. Do not add a cover,
   brand colors or extra pages unless the user wants them.
4. Prefer semantic heading styles, short body paragraphs, simple narrow tables,
   optional rich-text runs and workspace-local image blocks. Do not simulate
   alignment with spaces. Preserve user content; never pad a target page count.
5. Inspect the resulting file for expected content, headings, tables and images.
   Structural success is not visual QA. A sidepanel/HTML view is not proof of Word
   pagination. If an authorized renderer is available, render the final DOCX and
   inspect its pages; record the renderer. Do not claim identical Word/WPS layout.
6. No renderer/vision model: mark visual QA not performed and deliver the file.
   Respect requests to skip checks. Do not run the workspace npm tests for an
   unrelated document. Avoid repeated model reviews or mandatory subagents.
7. Deliver a short message with a clickable workspace file link and any actual
   preview/PDF link. State unresolved fidelity issues briefly, not a process diary.

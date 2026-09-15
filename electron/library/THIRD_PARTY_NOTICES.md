# Curated extension sources

Each package includes its upstream license and `.aporiax-source.json` with repository, pinned commit, file mapping and SHA-256 checksums. The AporiaX `SKILL.md` wrappers are adaptations, not a claim of endorsement by the upstream authors.

| Package | Upstream | Included material | License |
| --- | --- | --- | --- |
| word-professional | [MiniMax-AI/skills](https://github.com/MiniMax-AI/skills/tree/main/skills/minimax-docx) | Design, typography and CJK references; no .NET setup scripts | MIT |
| document-themes | [anthropics/skills theme-factory](https://github.com/anthropics/skills/tree/main/skills/theme-factory) | Three text theme definitions; not the separately licensed document skills | Apache-2.0 |
| systematic-debugging | [obra/superpowers](https://github.com/obra/superpowers/tree/main/skills/systematic-debugging) | Debugging and root-cause references; no global hooks or mandatory subagents | MIT |
| hermes-docx | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/main/skills/productivity/docx) | Word scripts, shared helper and reference instructions; optional Python dependency | MIT |

MCP catalog entries are configuration templates, not vendored servers: Playwright (Apache-2.0), MCP filesystem (MIT), Context7 (MIT), GitHub MCP (MIT), MarkItDown (MIT). Installing/using their servers is subject to their own dependencies, licensing, API terms and permissions. Pinned npm versions are recorded in `catalog.json`.

No fonts, third-party credentials, proprietary document skills or user documents are included. Importing a package does not execute it. Missing runtime/credentials must not be described as a verified working integration.

AporiaX modified Hermes `scripts/docx_common.py` to avoid replacement loops when the new text contains the search text, and to avoid processing shared paragraphs repeatedly. Its source manifest records both the original upstream checksum and the modified local checksum. The upstream MIT notice is retained.

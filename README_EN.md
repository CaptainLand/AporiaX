<p align="center">
  <img src="build/icon.png" width="88" alt="AporiaX" />
</p>

<h1 align="center">AporiaX</h1>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <em>Every problem begins with an aporia.</em>
</p>

<p align="center">
  <a href="https://github.com/CaptainLand/AporiaX/tree/main"><img alt="Source v0.9.9" src="https://img.shields.io/badge/source-v0.9.9-59a9cf"></a>
  <a href="https://github.com/CaptainLand/AporiaX/releases"><img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-202830?logo=windows"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-59a9cf.svg"></a>
</p>

<p align="center">
  <img src="docs/assets/aporiax-social-preview.jpg" width="100%" alt="AporiaX — Every problem begins with an aporia." />
</p>

AporiaX is a local-first Windows desktop agent. It edits code, runs commands, and creates Word / PowerPoint / Excel files inside an authorized workspace. Conversation, files, browser, terminal, and Git share one screen. Steps, evidence, and rollback stay in the UI instead of collapsing into a chat reply.

> [!IMPORTANT]
> Current source and Windows release: **`v0.9.9` Preview**.
> This build improves Harness task memory, recovery, process waiting, and acceptance evidence. Strict replanning and native provider protocols are opt-in.
> Aporia Account, Aporia Cloud, your own APIs, and local models stay independent. Quota exhaustion does not silently switch paths.
> Binaries are unsigned. Quit the previous build before updating.

## What it can do today

| Capability | Current implementation |
| --- | --- |
| Code and workspace | Paged/ranged reads, bundled ripgrep, file tree, preview/editing, multi-file Unified Patch, Git status and diff |
| Same-screen workbench | Files, Browser, terminal, Git, and side chat beside the conversation; Agent opens sidebar tabs with `present_to_user` |
| Language intelligence | Persistent LSP diagnostics, definition, references, hover, document symbols, workspace symbols, plus approval-gated language-server installation |
| Git / GitHub | Init, stage/commit/branch, remotes, pull/push, repository creation; sidebar editing of ordinary UTF-8 merge conflicts; read-only PR and CI for the current branch |
| Permissions and execution | Smart Permission plus Direct / Safe / Isolated; Safe does not write the host `node_modules`; Isolated refuses to run without Docker |
| Aporia Account | Browser authorization, PKCE, Main-only Access Token, safeStorage Refresh Token, account/quota/device state |
| Aporia Cloud | Managed DeepSeek V4 Flash / Pro, rolling weekly quota, Main-process Gateway, isolated from BYOK / Local |
| Cloud Vision | Explicit image attachments are analyzed once by Qwen3.5 Flash and passed to the DeepSeek Agent as compact text observations |
| Document production | Real `.docx`, `.pptx`, and `.xlsx` generation with structural inspection |
| Adaptive multi-agent execution | Adaptive Agent Budget keeps simple tasks Main-only and grants bounded extra agents when complexity needs them |
| Builder orchestration | Concurrency 0 / 1 / 2 / 3 / 4 / 6, default 2, with Task Graph, Scope Leases, isolated Git worktrees, and conflict-safe merge |
| Agent collaboration | Shared Contracts, Plan Approval, structured handoffs, and a bounded mailbox; Main remains final integration authority |
| Observable execution | Witness reports main/subagent activity, duration, failures, and self-check stages while Route preserves the full trace |
| Review and rollback | File snapshots, line diffs, Office binary checkpoints, per-turn Anchors, cross-turn recovery, and conflict checks |
| Independent checks | The main agent selects relevant commands and review; delivery with unverified or failed status is allowed |
| Project understanding | Understanding stores reusable architecture, conventions, commands, preferences, and debugging knowledge for the workspace |
| Extensions | Skills, MCP, Browser, Office, and native tools share the same capability system |
| Multiple model APIs | Aporia Cloud plus multiple OpenAI-compatible providers/keys, `/models` discovery, and task-level model selection |
| Desktop background | Tasks may continue in the Windows tray with restore/exit, completion notifications, and live runtime display |
| Local OCR | Chinese/English engine remains; language data downloads on first use; composer, attachment, and sidebar entries are hidden for now |

See [SECURITY.md](SECURITY.md) for boundaries.

<table>
  <tr>
    <td width="50%"><img src="docs/assets/welcome.png" alt="AporiaX light Gem Smoke welcome screen" /></td>
    <td width="50%"><img src="docs/assets/about.png" alt="AporiaX Settings About" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Begin with an aporia</strong><br><sub>Light welcome screen, bilingual entry</sub></td>
    <td align="center"><strong>See the route, roll back</strong><br><sub>Route · Evidence · Anchor</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/dialogue.png" alt="AporiaX Dialogue and self-check" /></td>
    <td width="50%"><img src="docs/assets/route.png" alt="AporiaX Route action trace" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Dialogue</strong><br><sub>Tasks, checks, deliverables, follow-ups</sub></td>
    <td align="center"><strong>Route</strong><br><sub>Tools, files, commands, concrete edits</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/workspace.png" alt="AporiaX Workspace file tree and Anchors" /></td>
    <td width="50%"><img src="docs/assets/understanding.png" alt="AporiaX shared Project Understanding" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Workspace</strong><br><sub>Tree, preview, Anchors</sub></td>
    <td align="center"><strong>Understanding</strong><br><sub>Shared architecture and conventions</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/settings-general.png" alt="AporiaX General settings" /></td>
    <td width="50%"><img src="docs/assets/settings-extensions.png" alt="AporiaX Extensions library" /></td>
  </tr>
  <tr>
    <td align="center"><strong>General</strong><br><sub>Language, appearance, models, execution</sub></td>
    <td align="center"><strong>Extensions</strong><br><sub>Reviewable Skills and MCP</sub></td>
  </tr>
</table>

## 0.9.9

- Keep source-backed decisions, rejected approaches, and open questions across long tasks; retain diagnostics and result references through compaction.
- Share ordered tool scheduling between main and child agents; wait for process output/exit events to avoid unnecessary polling.
- Bound context/output recovery and advise replanning on repeated failures or oscillation; strict per-issue budgets are optional.
- Optional acceptance contracts check files and existing command evidence without launching project tests or claiming unverified success.
- Explicitly select native provider protocols while compatible Chat remains the default. No live-model A/B speed or cost claim is made.

[Full 0.9.9 notes and comparison](docs/RELEASE_NOTES_v0.9.9.md) · [Changelog](CHANGELOG.md)

## Download

`main` is **v0.9.9**. Windows x64 installer and portable builds are on GitHub Releases.

| Windows x64 | Current package |
| --- | --- |
| [Browse Releases](https://github.com/CaptainLand/AporiaX/releases) | History and notes |
| [0.9.9 Installer](https://github.com/CaptainLand/AporiaX/releases/download/v0.9.9/AporiaX-Setup-0.9.9-x64.exe) | Recommended |
| [0.9.9 Portable](https://github.com/CaptainLand/AporiaX/releases/download/v0.9.9/AporiaX-Portable-0.9.9-x64.exe) | No install |

First launch:

1. Create a task and choose a local workspace.
2. Sign in to Aporia Account for Aporia Cloud, or add your own OpenAI-compatible / local provider.
3. Describe the outcome, then inspect Route, file changes, self-check, and deliverables.

## Run from source

**Node.js 22.12.0 or newer.** Docker Desktop is required only for Isolated mode. Direct and Safe run without Docker.

```powershell
git clone https://github.com/CaptainLand/AporiaX.git
cd AporiaX
npm install
npm run dev
```

API keys are encrypted with Electron `safeStorage` and never returned to the renderer. Do not put real credentials in source, `.env`, issues, or logs. Legacy DeepSeek still accepts `DEEPSEEK_API_KEY`.

```powershell
npm run dev          # development
npm run build        # production renderer
npm run dist:win     # Windows installer and portable
npm run test:audit-suite
```

## Subagents and project rules

Read-only explore, review, and verify work can go to isolated subagents. Writable Git tasks can delegate Builders: concurrency **0 / 1 / 2 / 3 / 4 / 6, default 2**, writing in isolated worktrees under scoped leases, then merging through the main agent after conflict checks.

Harness reads `AGENTS.md`, `APORIAX.md`, `DEEPAGENT.md`, and `.aporiax/rules/*.md`. Understanding stores verified commands, architecture, and explicit preferences; credentials are rejected.

`.aporiax.json` in the workspace root can only **tighten** permissions:

```json
{
  "permissions": {
    "write_file": "ask",
    "apply_patch": "ask",
    "run_command": "deny"
  }
}
```

```text
electron/   Main process, Harness, tools, security boundaries
src/        UI, workbench, review
tests/      Runtime and behavior checks
docs/       Architecture and release notes
build/      Icons and pack resources
```

Roadmap: [docs/HARNESS_ROADMAP.md](docs/HARNESS_ROADMAP.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately via [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 CaptainLand

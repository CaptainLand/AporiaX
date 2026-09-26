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
  <a href="https://github.com/CaptainLand/AporiaX/releases/tag/v1.0.0-rc.1"><img alt="Release v1.0.0-rc.1" src="https://img.shields.io/badge/release-v1.0.0--rc.1-59a9cf"></a>
  <a href="https://github.com/CaptainLand/AporiaX/releases"><img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-202830?logo=windows"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-59a9cf.svg"></a>
</p>

<p align="center">
  <img src="docs/assets/aporiax-social-preview.jpg" width="100%" alt="AporiaX — Every problem begins with an aporia." />
</p>

AporiaX is a local-first Windows desktop agent. It edits code, runs commands, and creates Word / PowerPoint / Excel files inside an authorized workspace. Conversation, files, browser, terminal, and Git share one screen. Steps, evidence, and rollback stay in the UI instead of collapsing into a chat reply.

> [!IMPORTANT]
> Current version: **`1.0.0-rc.1` release candidate**, not final 1.0.0.
> [Download RC1](https://github.com/CaptainLand/AporiaX/releases/tag/v1.0.0-rc.1). Installers use the default update channel; portable users replace the package manually. The Cloud minimum client version is unchanged.
> Focus: Skill / MCP / mention loops, task recovery and context headroom. Features are frozen for candidate testing.
> See [RC1 notes](docs/RELEASE_NOTES_v1.0.0-rc.1.md) and the [validation checklist](docs/releases/1.0.0-rc.1-validation.md).
> MIT remains in effect for this RC; the proposed license is reserved for final stable review. Cloud remains a separate beta.
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
| Agent collaboration | Independent child contexts inherit original user constraints; structured results await Main review. Builders do not execute shell commands; Main / Verify owns verification |
| Observable execution | Newest-first execution records, current actions, detail dialogs, per-run Main / Explore / Review / Verify / Curator / Builder activation counts, and Builder concurrency/queue/peak |
| Pause and recovery | Wait through temporary network loss and resume after wake; Main and children share pause gates, retaining received context and receipts without replaying uncertain side effects |
| Review and rollback | File snapshots, line diffs, Office binary checkpoints, per-turn Anchors, cross-turn recovery, and conflict checks |
| Independent checks | The main agent selects relevant commands and review; delivery with unverified or failed status is allowed |
| Project knowledge | Multiple knowledge projects per workspace, per-task selection and opt-in access, tool-driven reads instead of full-store context injection, with sources and revision history |
| Extensions | Skills, MCP, Browser, Office, and native tools share the same capability system |
| Multiple model APIs | Aporia Cloud plus multiple OpenAI-compatible providers/keys, `/models` discovery, and task-level model selection |
| Desktop background | Tasks may continue in the Windows tray with restore/exit, completion notifications, and live runtime display |
| Local OCR | Chinese/English engine remains; language data downloads on first use; composer, attachment, and sidebar entries are hidden for now |

See [SECURITY.md](SECURITY.md) for boundaries.

### Privacy and data flow

The current source removes the mobile companion channel: no background synchronization of local projects, full conversations, task snapshots or computer files to Cloud for mobile access. Remote-command polling and file-transfer IPC are removed as well. Signing in still exchanges the necessary account, quota and device information. A new desktop build is required; already installed older versions do not remove their own code.

Local-first does **not** mean offline. When you choose Aporia Cloud or another online model, inference still sends the prompt, relevant conversation and tool/file excerpts, and explicitly attached content needed for that request. Authorized network tools, MCP calls and Git pushes remain separate network operations. See [SECURITY.md](SECURITY.md) for the full boundary.

## Interface preview

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
    <td width="50%"><a href="docs/assets/dialogue.png"><img src="docs/assets/dialogue.png" width="100%" alt="AporiaX 1.0.0-preview dialogue and Witness execution summary" /></a></td>
    <td width="50%"><a href="docs/assets/route.png"><img src="docs/assets/route.png" width="100%" alt="AporiaX 1.0.0-preview execution records, agent activations and Builder concurrency" /></a></td>
  </tr>
  <tr>
    <td align="center"><strong>Dialogue</strong><br><sub>Task replies, Witness summaries and follow-ups</sub></td>
    <td align="center"><strong>Execution records</strong><br><sub>Newest first · Agent activations and Builder concurrency</sub></td>
  </tr>
  <tr>
    <td width="50%"><a href="docs/assets/workspace.png"><img src="docs/assets/workspace.png" width="100%" alt="AporiaX 1.0.0-preview workspace file tree, syntax highlighting and sidebar preview entry" /></a></td>
    <td width="50%"><a href="docs/assets/understanding.png"><img src="docs/assets/understanding.png" width="100%" alt="AporiaX 1.0.0-preview project knowledge selector, categories, search and sources" /></a></td>
  </tr>
  <tr>
    <td align="center"><strong>Workspace</strong><br><sub>File tree, syntax highlighting and sidebar previews</sub></td>
    <td align="center"><strong>Project knowledge</strong><br><sub>Organized by project, retrieved on demand</sub></td>
  </tr>
  <tr>
    <td width="50%"><a href="docs/assets/sidebar-documents.png"><img src="docs/assets/sidebar-documents.png" width="100%" alt="AporiaX sidebar Markdown reading, source and editing modes beside the main conversation" /></a></td>
    <td width="50%"><a href="docs/assets/sidebar-browser.png"><img src="docs/assets/sidebar-browser.png" width="100%" alt="AporiaX embedded sidebar browser beside the main conversation" /></a></td>
  </tr>
  <tr>
    <td align="center"><strong>Sidebar · Documents</strong><br><sub>Formatted Markdown with reading, source and editing modes</sub></td>
    <td align="center"><strong>Sidebar · Browser</strong><br><sub>Browse alongside your task without leaving the conversation</sub></td>
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

The dialogue, execution records, workspace, project knowledge and two sidebar screenshots now show 1.0.0-preview; click them to view the originals. Welcome, About and settings screenshots are retained from earlier versions; the current package is authoritative.

## 1.0.0-rc.1

- **Extension loop completion:** MCP steering, durable selection recovery and explicit reconnect; complete Skill instructions and referenced resources.
- **Safer references:** browser snapshots are frozen per user message, not recaptured after navigation on retry; mention sources load independently.
- **Context headroom:** correct excessive fixed reservation on 32K models without dropping constraints or hard limits.

Retained Preview capabilities:

- **Wait instead of failing immediately:** temporary connection loss uses backoff; sleep pauses new work and wake resumes it. Automatic recovery never clears a manual pause or resurrects a stopped task.
- **Clearer collaboration:** child contexts retain user constraints and return structured results for review. Pause gates cover children and the Builder queue without changing the selected concurrency cap.
- **Readable execution records:** separate current actions from newest-first history, inspect details, and see per-run agent activation and Builder queue counts.
- **On-demand project knowledge:** keep multiple knowledge projects in one workspace and select access per task; simplified project controls and tool-driven reads.
- **Easier setup and previews:** signed-out Cloud models are disabled with a prompt to add your API; workspace files reuse sidebar previews, with Anchors collapsed by default.
- **Retain the 0.9.9 foundations:** source-backed decisions, diagnostic retention, ordered tools, process-event waiting, and evidence-based acceptance without unrelated forced tests or false verification claims.

Current candidate results and remaining gates are tracked in the [validation checklist](docs/releases/1.0.0-rc.1-validation.md). The preceding repair passed 81/81 local scripts; that is not proof of this package, remote CI, every real model or clean-machine acceptance.

> Automatic continuation requires the app process to remain alive. Power loss, exit, or crashes still require manual recovery. Preserved memory means received, saveable task state, not provider-side computation that never returned. Unknown command/upload outcomes are not blindly replayed, and reconnecting may incur duplicate charges. Real hardware network-loss and sleep/wake checks remain outstanding.

[RC1 notes](docs/RELEASE_NOTES_v1.0.0-rc.1.md) · [Historical Preview notes](docs/RELEASE_NOTES_v1.0.0-preview.md) · [Changelog](CHANGELOG.md)

## Download

**RC1 release candidate**: download from [GitHub Latest](https://github.com/CaptainLand/AporiaX/releases/latest), or use the installer build's sidebar update entry. This is not final 1.0.0.

Use Settings → About → Check for updates to refresh manually. Current source checks on every launch and every 30 minutes while running; the sidebar entry hides when no update is available. Installed builds download and restart to install; portable builds open the download page for manual replacement. This local RC will not notify existing users of an update.

| Windows x64 | Source |
| --- | --- |
| [Browse Releases](https://github.com/CaptainLand/AporiaX/releases) | History and notes |
| [Public Latest](https://github.com/CaptainLand/AporiaX/releases/latest) | Select Setup / Portable and matching SHA256SUMS from the same release |
| RC1 download | [Installer](https://github.com/CaptainLand/AporiaX/releases/download/v1.0.0-rc.1/AporiaX-Setup-1.0.0-rc.1-x64.exe) · [Portable](https://github.com/CaptainLand/AporiaX/releases/download/v1.0.0-rc.1/AporiaX-Portable-1.0.0-rc.1-x64.exe) |

First launch:

1. Create a task and choose a local workspace.
2. Add your own API / local provider in the model picker, or sign in to Aporia Account for Aporia Cloud. Signed-out Cloud models are disabled.
3. Optionally select project knowledge for this task, describe the outcome, and inspect execution records, files, and deliverables.

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
npm run test:suspension # automatic pause/recovery scenarios
```

## Subagents and project rules

Read-only explore, review, and verify work can go to isolated subagents. Writable Git tasks can delegate Builders: concurrency **0 / 1 / 2 / 3 / 4 / 6, default 2**, writing in isolated worktrees under scoped leases, then merging through the main agent after conflict checks.

Builders use file tools within their delegated scope, not shell execution or publishing. Main / Verify selects relevant checks; Main reviews returned results.

Harness reads `AGENTS.md`, `APORIAX.md`, `DEEPAGENT.md`, and `.aporiax/rules/*.md`. Project knowledge stores commands, architecture, and explicit preferences separately per knowledge project. Tasks can disable access or read on demand; the full store is not forcibly injected, and credentials are rejected.

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

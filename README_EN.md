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
  <a href="https://github.com/CaptainLand/AporiaX/tree/main"><img alt="Source v0.9.8" src="https://img.shields.io/badge/source-v0.9.8-59a9cf"></a>
  <a href="https://github.com/CaptainLand/AporiaX/releases"><img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-202830?logo=windows"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-59a9cf.svg"></a>
</p>

<p align="center">
  <img src="docs/assets/aporiax-social-preview.jpg" width="100%" alt="AporiaX — Every problem begins with an aporia." />
</p>

AporiaX is a local-first Windows desktop agent. It edits code, runs commands, and creates Word / PowerPoint / Excel files inside an authorized workspace. Conversation, files, browser, terminal, and Git share one screen. Steps, evidence, and rollback stay in the UI instead of collapsing into a chat reply.

> [!IMPORTANT]
> Current source and Windows release: **`v0.9.8` Preview**.
> This build hardens task history and file writes, and steadies Builder / Safe execution. The OCR engine remains; composer OCR buttons are hidden for now.
> Aporia Account, Aporia Cloud, your own APIs, and local models stay independent. Quota exhaustion does not silently switch paths.
> Binaries are unsigned. Quit the previous build before updating.

## What it can do now

- **Authorized workspace**: paged/ranged reads, search, file tree, preview, edits, multi-file patches; optional LSP diagnostics and navigation.
- **Same-screen workbench**: files, in-app Browser, terminal, Git, and side chat beside the conversation. The Agent opens sidebar tabs with `present_to_user`; links in the final answer do not auto-open.
- **Git**: diffs, stage, commit, branches, init/clone, remotes, and GitHub sign-in. Ordinary UTF-8 merge conflicts can be edited in the sidebar. PRs and checks for the current branch are read-only.
- **Execution**: Direct writes the workspace; Safe uses a workspace copy and does not write the host `node_modules`; Isolated needs Docker and refuses to run without it. Risky actions still require approval.
- **Models**: sign in for hosted DeepSeek V4 Flash / Pro, or add OpenAI-compatible / local providers. Cloud image attachments can use Cloud Vision; BYOK/local vision depends on your own model.
- **Documents and extensions**: real `.docx` / `.pptx` / `.xlsx`. Skills and MCP share one capability system; inspect source and license before install.
- **Visible rollback**: Route records what happened, Witness tracks live work, Anchor previews diffs and restores workspace files.
- **Desktop**: tasks can continue in the Windows tray. Installed builds can check GitHub Releases in-app.

The local OCR engine is still present (Chinese/English; language data downloads on first use). Its UI entry points are hidden. See [SECURITY.md](SECURITY.md) for boundaries.

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

## 0.9.8

- Task history is harder to lose: partial migrations retry and keep originals, corrupt records do not block healthy tasks, deletes are archived.
- Ordinary writes, patches, and Office files share recoverable commits with Builder merges.
- Builders use delegated snapshot/merge. Concurrency is 0–6, default 2. Safe keeps private dependencies between successful commands in one task.
- OCR runs in a killable child process. Composer, attachment, and sidebar OCR buttons are hidden for now.
- Privileged IPC checks the main window origin. MCP timeout/cancel does not claim remote side effects were undone.

[Full 0.9.8 notes](docs/RELEASE_NOTES_v0.9.8.md) · [Changelog](CHANGELOG.md)

## Download

`main` is **v0.9.8**. Windows x64 installer and portable builds are on GitHub Releases.

| Windows x64 | Current package |
| --- | --- |
| [Browse Releases](https://github.com/CaptainLand/AporiaX/releases) | History and notes |
| [0.9.8 Installer](https://github.com/CaptainLand/AporiaX/releases/download/v0.9.8/AporiaX-Setup-0.9.8-x64.exe) | Recommended |
| [0.9.8 Portable](https://github.com/CaptainLand/AporiaX/releases/download/v0.9.8/AporiaX-Portable-0.9.8-x64.exe) | No install |

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

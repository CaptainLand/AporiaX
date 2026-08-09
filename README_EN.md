<p align="center">
  <img src="build/icon.png" width="88" alt="AporiaX" />
</p>

<h1 align="center">AporiaX</h1>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <strong>Begin with an aporia.</strong><br>
  Write code, create documents, presentations, and spreadsheets. Tell AporiaX where you want to arrive.
</p>

<p align="center">
  <em>Every problem begins with an aporia.</em>
</p>

<p align="center">
  <a href="https://github.com/CaptainLand/AporiaX/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/CaptainLand/AporiaX?color=59a9cf"></a>
  <a href="https://github.com/CaptainLand/AporiaX/releases/download/v0.4.1/AporiaX-Setup-0.4.1-x64.exe"><img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-202830?logo=windows"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-59a9cf.svg"></a>
</p>

<p align="center">
  <img src="docs/assets/aporiax-social-preview.jpg" width="100%" alt="AporiaX — Every problem begins with an aporia." />
</p>

AporiaX is a local-first desktop agent that turns ambiguous requests into
observable, verifiable, and reversible routes. It works directly inside an
authorized workspace, edits code, creates real Office files, and keeps actions,
evidence, changes, and deliverables visible instead of reducing the work to a
chat response.

> [!IMPORTANT]
> AporiaX `v0.4.1` is still a preview and currently ships for Windows x64.
> `run_command` runs automatically in a temporary local workspace copy and
> conflict-checks project changes before synchronizing them back. Docker is
> entirely optional; enabling it upgrades execution to an offline,
> read-only-root OS-level container. The local sandbox isolates workspace
> changes but still uses the current user's host network and process permissions.

## Why AporiaX

- **Route** shows the steps that actually occurred during every task.
- **Evidence** preserves tool calls, file changes, verification, and failures.
- **Anchor** brings restorable checkpoints beside each turn, with diff preview,
  conflict detection, and safe rollback.

## See the work happen

<table>
  <tr>
    <td width="50%"><img src="docs/assets/welcome.png" alt="AporiaX particle-ocean welcome screen" /></td>
    <td width="50%"><img src="docs/assets/about.png" alt="AporiaX Route Evidence Anchor" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Begin with an aporia</strong><br><sub>A restrained particle-ocean welcome screen with bilingual entry</sub></td>
    <td align="center"><strong>Route · Evidence · Anchor</strong><br><sub>See the route, preserve the evidence, and roll back safely</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/dialogue.png" alt="AporiaX Dialogue and mandatory self-check" /></td>
    <td width="50%"><img src="docs/assets/route.png" alt="AporiaX Route action trace" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Dialogue</strong><br><sub>Tasks, self-checks, deliverables, and follow-ups in one workflow</sub></td>
    <td align="center"><strong>Route</strong><br><sub>Inspect tools, files, commands, timing, and concrete changes step by step</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/workspace.png" alt="AporiaX Workspace file tree and Anchors" /></td>
    <td width="50%"><img src="docs/assets/understanding.png" alt="AporiaX shared Project Understanding" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Workspace</strong><br><sub>Expand the project tree, preview code, and manage cross-turn Anchors</sub></td>
    <td align="center"><strong>Understanding</strong><br><sub>Version architecture, conventions, commands, preferences, and debugging knowledge</sub></td>
  </tr>
</table>

## What it can do today

| Capability | Current implementation |
| --- | --- |
| Code and workspace | File tree, search, preview, editing, `Ctrl+S`, precise patches, Git status and diff |
| Document production | Real `.docx`, `.pptx`, and `.xlsx` generation with structural inspection |
| Observable execution | Witness reports the current main/subagent action, duration, failures, and self-check phase in Dialogue; Route preserves the full trace |
| Review and rollback | File snapshots, line diffs, Office binary checkpoints, per-turn Anchors, cross-turn recovery, and atomic conflict checks |
| Mandatory self-check | Review/Verify subagents inspect current file versions in stages, followed by a lightweight final seal over tests, risks, and deliverables |
| Subagents and context | Parallel reads and search; isolated Explore, Review, and Verify subagents; scoped rules, structured compaction, and relevant-history recall |
| Project understanding | One workspace forms one project; versioned Understanding shares architecture, conventions, commands, preferences, and debugging knowledge across its tasks |
| Multiple model APIs | Multiple OpenAI-compatible providers and keys, `/models` discovery, task-level model selection |
| Bilingual interface | Switch Chinese and English from the welcome screen or settings; new replies follow the interface language |
| Attachments | PDF, Office, Markdown, code, and image attachments with local PDF text extraction |
| Permissions and execution | `allow` / `ask` / `deny` policy, automatic local workspace sandbox, optional stronger Docker isolation |

Scanned PDFs are detected as requiring OCR, but an OCR engine is not bundled
yet. Image delivery depends on the vision capability of the selected model.

## Download

| Windows x64 | Use case |
| --- | --- |
| [Installer 0.4.1](https://github.com/CaptainLand/AporiaX/releases/download/v0.4.1/AporiaX-Setup-0.4.1-x64.exe) | Standard installation, desktop shortcut, and Start menu |
| [Portable 0.4.1](https://github.com/CaptainLand/AporiaX/releases/download/v0.4.1/AporiaX-Portable-0.4.1-x64.exe) | Run and evaluate without installation |

### What's new in 0.4.1: from a single tool loop to a project-level agent system

- **Parallel subagents** — Explore, Review, and Verify work with isolated context and permissions, reducing main-context pollution and long-task blocking.
- **Witness and Route** — Dialogue keeps the current main/subagent work visible, while Route groups evidence into expandable understanding, exploration, execution, and verification phases.
- **Staged self-check** — changed file versions are reviewed as work progresses, followed by a lightweight final seal instead of a full mechanical reread.
- **Project Understanding** — architecture, conventions, commands, preferences, and debugging knowledge become versioned project context shared across tasks in the same workspace.
- **Projects and tasks** — one workspace maps to one project containing multiple tasks; Workspace now opens as a collapsible tree rooted at the project directory.
- **Per-turn Anchor** — preview affected files and exact diffs beside a reply, then atomically restore after explicit confirmation; later edits stop the restore safely.

[Read the complete 0.4.1 release notes](docs/RELEASE_NOTES_v0.4.1.md)

After the first launch:

1. Create a task and choose a local workspace.
2. Add an OpenAI-compatible API provider and model.
3. Describe the outcome, then inspect Route, file changes, self-check, and deliverables.

Docker Desktop is optional. Without it, commands run automatically in a
temporary workspace copy and project changes are conflict-checked before they
are synchronized back. With Docker enabled, commands use a network-disabled
container with stronger OS-level isolation.

## Run from source

Node.js 20 or newer is required. Start Docker Desktop only if you want stronger
containerized `run_command`; the in-app **Enable stronger Docker isolation**
action builds the local `aporiax-sandbox:0.1` image. Commands work without
Docker and do not require per-command approval in automatic mode.

```powershell
git clone https://github.com/CaptainLand/AporiaX.git
cd AporiaX
npm install
npm run dev
```

On first use, add an API base URL and API key in **Model providers**. AporiaX
supports OpenAI-compatible Chat Completions APIs, attempts model discovery
through `/models`, and also accepts manually entered model IDs. Multiple
providers can coexist, and each task can use a different model.

For backward compatibility, DeepSeek can also be configured through an
environment variable:

```powershell
$env:DEEPSEEK_API_KEY="your-api-key"
npm start
```

API keys are encrypted with Electron `safeStorage` and are never returned to
the renderer. Never put real credentials in source code, `.env`, issues, or
logs.

## Common commands

```powershell
# Development: Vite and Electron
npm run dev

# Runtime and P0 data model tests
npm run test:runtime
npm run test:p0

# Production web build
npm run build

# Windows installer and portable package
npm run dist:win
```

## Creating Office files

Create a task with workspace write access, bind a workspace, and describe the
deliverable:

```text
Create project-weekly-report.docx with a title, progress highlights, risks,
and a milestone table.
```

```text
Create a six-slide quarterly review.pptx and a sales-dashboard.xlsx with
growth formulas.
```

Harness uses structured Office tools, then re-parses document blocks, slides,
worksheets, and formulas. Structural inspection does not replace a final visual
review in Word, PowerPoint, or Excel.

## Subagents and project context

AporiaX runs independent read tools concurrently and delegates larger
exploration, review, and verification work to isolated Explore, Review, and
Verify subagents with their own context and path scope. Explore and Review are
read-only. Verify may run project checks when the task policy permits it.
Background subagents are collected before final delivery, and their internal
steps appear in Route without flooding the parent context with raw logs.

Harness recognizes these project rules:

- `AGENTS.md`, `APORIAX.md`, and `DEEPAGENT.md` at the workspace root or in nested directories.
- Path-scoped Markdown files under `.aporiax/rules/`, with optional `paths` globs in frontmatter.
- App-local project memory for verified commands, architecture conventions, and explicit preferences; credentials are rejected.

```markdown
---
paths:
  - src/**/*.js
---
Run the project syntax check after changing JavaScript.
```

Near the model context limit, Harness preserves system and scoped rules,
compacts older content into a structured checkpoint, and retrieves relevant
constraints, evidence, and project memory for the current work. When a
provider reports actual token usage, the estimator calibrates itself. Model
configuration may also provide `contextWindow`.

While a task is running, **Witness** at the bottom of Dialogue subscribes to
the Harness event stream and reports what the main agent and subagents are
doing. Witness is observation-only and never edits files. It surfaces
long-running actions and repeated tool failures while Route retains the full
tool evidence.

## Project-level permissions

Add `.aporiax.json` to the workspace root:

```json
{
  "permissions": {
    "write_file": "ask",
    "apply_patch": "ask",
    "create_word_document": "ask",
    "create_presentation": "ask",
    "create_spreadsheet": "ask",
    "delegate_subagent": "allow",
    "remember_project_fact": "allow",
    "run_command": "deny"
  }
}
```

Project configuration can only restrict task permissions. It cannot elevate a
read-only task or disable Harness control tools used by mandatory self-check.

## Repository layout

```text
electron/   Electron main process, Harness, tools, and security boundaries
src/        React UI, Route, Workspace, and review experience
tests/      Runtime and P0 behavior tests
docs/       Architecture and Harness roadmap
build/      Application icons and build resources
```

See [docs/HARNESS_ROADMAP.md](docs/HARNESS_ROADMAP.md) for current Harness
architecture and plans. See
[docs/RELEASE_NOTES_v0.4.1.md](docs/RELEASE_NOTES_v0.4.1.md) for this release.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as
described in [SECURITY.md](SECURITY.md); never disclose real credentials or
vulnerability details publicly.

## License

[MIT](LICENSE) © 2026 CaptainLand

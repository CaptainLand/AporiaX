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
  <a href="https://github.com/CaptainLand/AporiaX/releases/download/v0.6.0/AporiaX-Setup-0.6.0-x64.exe"><img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-202830?logo=windows"></a>
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
> AporiaX `v0.6.0` is still a preview and currently ships for Windows x64.
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
| Adaptive multi-agent execution | Adaptive Agent Budget keeps simple tasks Main-only and grants bounded extra agents only when task complexity needs them |
| Builder orchestration | Eligible large write tasks can use up to two Builders with Task Graph scheduling, Scope Leases, isolated Git worktrees, and conflict-safe merge |
| Agent collaboration | Shared Contracts, deterministic Plan Approval, structured handoffs, semantic disagreement checks, and a bounded mailbox; Main remains final integration authority |
| Observable execution | Witness reports the current main/subagent action, duration, failures, and self-check phase in Dialogue; Route preserves the full trace |
| Review and rollback | File snapshots, line diffs, Office binary checkpoints, per-turn Anchors, cross-turn recovery, and atomic conflict checks |
| Mandatory self-check | Review/Verify subagents inspect current file versions in stages, followed by a lightweight final seal over tests, risks, and deliverables |
| Subagents and context | Parallel reads and search; isolated Explore, Review, Verify, Curator, and scope-bounded Builder roles; scoped rules, structured compaction, and relevant-history recall |
| Desktop background lifecycle | Closing the main window can keep tasks running in the system tray, with tray restore/exit, Windows completion notifications, and live task runtime display |
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
| [Installer 0.6.0](https://github.com/CaptainLand/AporiaX/releases/download/v0.6.0/AporiaX-Setup-0.6.0-x64.exe) | Standard installation, desktop shortcut, and Start menu |
| [Portable 0.6.0](https://github.com/CaptainLand/AporiaX/releases/download/v0.6.0/AporiaX-Portable-0.6.0-x64.exe) | Run and evaluate without installation |

### What's new in 0.6.0: from accumulated features to an extensible local Agent platform

- **Architecture reconstruction** — native React conversation UI, a single-source TaskStore, pure event reducers, explicit run/turn coordination, and testable runtime modules replace migration-era bridges.
- **Unified capability system** — native tools, Office, Browser, Skills, and MCP share one Capability Registry that drives permissions, Route presentation, and extension visibility.
- **Skill / MCP Extensions center** — a bilingual library, install/configure flows, source policies, lifecycle controls, and trusted local or remote MCP server connections.
- **More reliable multi-agent work** — scoped Builder, Explore, Review, Verify, and Curator roles; bounded parallel preflight review; version-matched findings; and evidence-based final sealing.
- **Witness and long-command governance** — durable progress records, slow-command warnings, strategy-adjustment signals, and bounded process-tree cleanup.
- **Autonomous Understanding** — Curator decides whether task evidence is durable enough to update shared architecture, conventions, commands, preferences, or debugging knowledge.
- **Local sandbox and recovery** — Docker is optional; temporary workspace execution adds secret filtering, conflict checks, and safe synchronization while task isolation, stopped-run recovery, and retries are hardened.
- **Browser, vision, and workspace context** — isolated Browser tools, vision proxy routing, ordered file mentions, stable live status, prompt folding, and lower-overhead streaming.

[Read the 0.6.0 GitHub Release](https://github.com/CaptainLand/AporiaX/releases/tag/v0.6.0) · [Read the complete changelog](CHANGELOG.md)

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

# Harness / Collaboration / Desktop smoke tests
npm run test:architecture
npm run test:collaboration
npm run test:harness-v2
npm run test:desktop-background

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
Verify subagents with their own context and path scope. Curator handles explicit
durable project understanding. For eligible large writable Git tasks, Harness
can plan up to two Builders that work inside isolated Git worktrees under Scope
Leases before Main integrates their changes after conflict checks. Builders
cannot broaden write scope, run arbitrary commands, or recursively delegate agents.

Parallel Builders must pass a Shared Contract and Plan Approval first, sharing
cross-module invariants, acceptance criteria, and Main-owned shared-file
boundaries. They report results through structured handoffs and a bounded
mailbox. Main keeps final integration authority, while Witness only observes
and records.

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
architecture and plans. See [CHANGELOG.md](CHANGELOG.md) for this release.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as
described in [SECURITY.md](SECURITY.md); never disclose real credentials or
vulnerability details publicly.

## License

[MIT](LICENSE) © 2026 CaptainLand

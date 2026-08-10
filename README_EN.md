<p align="center">
  <img src="build/icon.png" width="88" alt="AporiaX" />
</p>

<h1 align="center">AporiaX</h1>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <strong>Adaptive · Observable · Conflict-safe Multi-Agent Harness</strong><br>
  <em>Every problem begins with an aporia.</em>
</p>

<p align="center">
  <a href="https://github.com/CaptainLand/AporiaX/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/CaptainLand/AporiaX?color=59a9cf"></a>
  <a href="https://github.com/CaptainLand/AporiaX/releases/download/v0.5.0/AporiaX-Setup-0.5.0-x64.exe"><img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-202830?logo=windows"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-59a9cf.svg"></a>
</p>

<p align="center">
  <img src="docs/assets/aporiax-social-preview.jpg" width="100%" alt="AporiaX — Every problem begins with an aporia." />
</p>

AporiaX is a **local-first desktop coding harness**. Instead of treating coding as one agent repeatedly calling tools inside a chat loop, AporiaX keeps one **Main Agent** as the final authority and adaptively brings in Explore, Builder, Review, Verify, Curator, and Witness roles only when a task actually benefits from them.

It works directly inside an authorized workspace, edits code, runs validation, creates real Office files, and keeps routes, evidence, file changes, conflict checks, and deliverables visible throughout the task.

> [!IMPORTANT]
> AporiaX `v0.5.0` is still a Preview release and currently ships for Windows x64.
> Closing the main window hides AporiaX to the system tray and keeps active tasks running **inside the existing Electron process**. Tasks do not survive a full process exit or restart yet.
> `run_command` executes in a temporary local workspace copy and conflict-checks changes before synchronizing them back. Docker is optional and upgrades execution to an offline, read-only-root OS-level container.

- **Route** shows the steps that actually happened instead of hiding execution behind prose.
- **Evidence** preserves tool calls, file changes, validation results, failures, and collaboration evidence.
- **Anchor** brings restorable checkpoints beside each turn with diff preview, conflict detection, and safe rollback.

## 0.5.0: from an agent system to an adaptive Multi-Agent Harness

`v0.5.0` is the largest Harness milestone so far. The goal is not to maximize agent count. The goal is to introduce additional agents **only when the work justifies them, under explicit boundaries and bounded coordination**.

### Adaptive Agent Budget

Simple requests do not pay a multi-agent tax: Main can complete them directly. Additional capacity is opened only when the task needs broader investigation, cross-module edits, review, verification, durable understanding, or explicit delegation.

- Simple tasks can remain **Main-only**.
- Read-heavy work can delegate to Explore / Review / Verify.
- Eligible large write tasks can use up to **2 Builders**.
- Total agents, concurrency, and role capacity are hard-bounded; there is no unrestricted team chat.

### Main + Builder: parallel execution without losing authority

Builders are not peer Main agents. Main remains responsible for decomposition, shared boundaries, integration, and the final delivery.

```text
User
  │
  ▼
Main ─────────────── final integration authority
  ├─ Explore        read-only investigation
  ├─ Builder A      isolated writable scope
  ├─ Builder B      isolated writable scope
  ├─ Review         semantic/static review
  ├─ Verify         build/test/runtime evidence
  ├─ Curator        durable project understanding
  └─ Witness        observation only
```

Each Builder works in an isolated Git worktree and is constrained by a **Scope Lease**:

- writable scopes are explicit before work starts;
- out-of-scope changes are rejected before merge-back;
- Builders cannot recursively delegate agents or arbitrarily broaden privileges;
- merge-back checks the baseline and concurrent edits so user/Main changes are not silently overwritten;
- dirty workspaces are preserved through an overlay and integrated with conflict checks.

### Collaboration v1: agree before parallelizing

Two Builders can disagree semantically even when they never touch the same file. AporiaX 0.5.0 adds a collaboration layer for those cross-boundary risks:

- **Shared Contract** for UI, API, schema, state, security, and acceptance invariants.
- **Plan Approval** before parallel Builder execution.
- **Structured Handoff** with summary, assumptions, Main follow-ups, contract assertions, and messages.
- **Bounded Mailbox** for questions, notices, and blockers without unlimited peer-to-peer context growth.
- **Semantic disagreement detection** after Builder waves, with Main making the final integration decision.

### Review / Verify / Witness stay independent

- **Review** focuses on semantic and static implementation quality.
- **Verify** focuses on build, test, lint, typecheck, and runtime evidence.
- **Witness** is observation-only and records Main/subagent actions, timing, failures, and collaboration state.
- Review and Verify are version-matched so stale evidence does not certify newer code.

### Harness Architecture v1

The internals also begin moving away from one giant Runtime toward an evolvable Harness architecture:

- Event Bus + Hook API
- Declarative Agent Definition
- clearer Session / Scheduler / Context / Tool / Review boundaries
- Plugin API
- a loopback-only Core Server / Desktop Client foundation

Core HTTP `taskRpc` remains disabled in 0.5.0. This release establishes the architecture without claiming detached-daemon execution or task survival after the desktop process exits.

### Windows background-task experience

0.5.0 also closes an important desktop UX gap:

- closing the main window hides AporiaX to the Windows tray instead of interrupting active work;
- the tray restores the same window and provides a real **Exit AporiaX** action;
- Dialogue shows elapsed task time and the tray status updates live runtime;
- hidden-task completion uses Windows/Electron system notifications;
- a one-time first-close notification explains that work continues in the tray;
- duplicate in-app completion toasts are suppressed so the system notification is the canonical background completion signal.

[Read the complete bilingual 0.5.0 release notes](docs/RELEASE_NOTES_v0.5.0.md)

## Download

| Windows x64 | Use case |
| --- | --- |
| [Installer 0.5.0](https://github.com/CaptainLand/AporiaX/releases/download/v0.5.0/AporiaX-Setup-0.5.0-x64.exe) | Standard installation, desktop shortcut, and Start menu |
| [Portable 0.5.0](https://github.com/CaptainLand/AporiaX/releases/download/v0.5.0/AporiaX-Portable-0.5.0-x64.exe) | Run and evaluate without installation |
| [GitHub Release](https://github.com/CaptainLand/AporiaX/releases/tag/v0.5.0) | Release notes, checksums, and build assets |

## See the work happen

<table>
  <tr>
    <td width="50%"><img src="docs/assets/welcome.png" alt="AporiaX particle-ocean welcome screen" /></td>
    <td width="50%"><img src="docs/assets/about.png" alt="AporiaX Route Evidence Anchor" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Begin with an aporia</strong><br><sub>Bilingual entry into a local-first desktop harness</sub></td>
    <td align="center"><strong>Route · Evidence · Anchor</strong><br><sub>See the route, preserve the evidence, and roll back safely</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/dialogue.png" alt="AporiaX Dialogue and self-check" /></td>
    <td width="50%"><img src="docs/assets/route.png" alt="AporiaX Route action trace" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Dialogue</strong><br><sub>Tasks, agents, self-checks, deliverables, and follow-ups in one workflow</sub></td>
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

## Current capabilities

| Capability | Current implementation |
| --- | --- |
| Adaptive agent topology | Adaptive Agent Budget; simple tasks can remain Main-only while complex tasks open bounded Explore / Review / Verify / Curator / Builder capacity |
| Parallel Builders | Up to 2 writable Builders with Scope Leases, isolated Git worktrees, dirty overlays, and conflict-safe merge-back |
| Collaboration contracts | Shared Contract, Plan Approval, structured handoff, bounded mailbox, semantic disagreement detection |
| Code and workspace | File tree, search, preview, editing, `Ctrl+S`, precise patches, Git status and diff |
| Observable execution | Witness + Route preserve agents, tools, timing, failures, self-checks, and collaboration evidence |
| Review and rollback | File snapshots, line diffs, Office binary checkpoints, per-turn Anchors, and atomic conflict checks |
| Document production | Real `.docx`, `.pptx`, and `.xlsx` generation with structural inspection |
| Project understanding | Versioned Understanding shares architecture, conventions, commands, preferences, and debugging knowledge |
| Multiple model APIs | Multiple OpenAI-compatible providers and keys, `/models` discovery, task-level model selection |
| Desktop background | Close-to-tray, hidden task continuation, system completion notifications, elapsed runtime |
| Permissions and execution | `allow` / `ask` / `deny`, automatic local workspace sandbox, optional stronger Docker isolation |
| Bilingual UI | Switch Chinese and English from the welcome screen or settings |

Scanned PDFs are detected as requiring OCR, but an OCR engine is not bundled yet. Image delivery depends on the vision capability of the selected provider model.

## Quick start

1. Create a task and choose a local workspace.
2. Add an OpenAI-compatible API provider and model.
3. Describe the outcome; AporiaX selects a Main-only or bounded multi-agent topology based on the task.
4. Inspect tools, Builders, Review, Verify, file changes, and deliverables in Dialogue / Route.

Docker Desktop is optional. Without it, commands run in a temporary workspace copy and changes are conflict-checked before synchronization. With Docker enabled, commands use a network-disabled container with a read-only root filesystem for stronger OS-level isolation.

## Run from source

Node.js 20 or newer is required.

```powershell
git clone https://github.com/CaptainLand/AporiaX.git
cd AporiaX
npm install
npm run dev
```

On first use, add an API Base URL and API Key under **Model Provider**. API keys are encrypted with Electron `safeStorage` and are not returned to the renderer. Never place real credentials in source code, `.env`, issues, or logs.

## Common commands

```powershell
# Development
npm run dev

# Main 0.5.0 smoke / regression gate
npm run test:desktop-background
npm run test:collaboration
npm run test:harness-v2
npm run test:architecture
npm run test:cache
npm run test:runtime

# Production web build
npm run build

# Windows Setup + Portable
npm run dist:win
```

## Architecture docs

- [Harness Architecture v1](docs/HARNESS_ARCHITECTURE_V1.md)
- [Harness Architecture v2 / Builder orchestration](docs/HARNESS_ARCHITECTURE_V2.md)
- [Harness Collaboration v1](docs/HARNESS_COLLABORATION_V1.md)
- [Desktop Background v1](docs/DESKTOP_BACKGROUND_V1.md)
- [0.5.0 Release Notes](docs/RELEASE_NOTES_v0.5.0.md)
- [Changelog](CHANGELOG.md)

## Known boundaries

- Core HTTP `taskRpc` is still disabled; credentials, approvals, pause/resume, and mutation control remain in the desktop Runtime.
- Close-to-tray keeps the Electron process alive, but active tasks do not survive a full exit/restart.
- Some legacy read-only subagent paths still execute through compatibility-runtime internals.
- Collaboration v1 intentionally does not provide unrestricted real-time peer-to-peer agent chat.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as described in [SECURITY.md](SECURITY.md); never disclose real credentials or vulnerability details publicly.

## License

[MIT](LICENSE) © 2026 CaptainLand

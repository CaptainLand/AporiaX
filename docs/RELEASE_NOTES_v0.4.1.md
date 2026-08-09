# AporiaX 0.4.1

> Every problem begins with an aporia.

AporiaX 0.4.1 is a Windows x64 preview that upgrades the desktop app from a
single-agent tool loop into an observable, project-level agent system. Long-running
work can now be delegated, monitored, reviewed in stages, shared across tasks, and
restored at the exact turn that produced a change.

## Highlights

- **Parallel subagents** — independent Explore, Review, and Verify agents receive
  isolated context, scoped tools, and task-appropriate permissions. Independent reads
  and searches can execute in parallel, while larger investigations stay out of the
  main model context.
- **Witness and a clearer Route** — Witness records main-agent and subagent activity,
  duration, failures, approvals, and self-check phases. Dialogue keeps current work
  visible, while Route groups the evidence into expandable phases instead of a long
  flat sequence of tool calls.
- **Staged self-check with a final seal** — Review/Verify subagents inspect current
  file versions as work progresses. The final pass verifies coverage, test evidence,
  deliverables, and remaining risks without mechanically rereading every file.
- **Versioned Project Understanding** — one workspace maps to one project. Architecture,
  conventions, verified commands, user preferences, and debugging lessons are curated
  into shared, versioned understanding that every task in the project can retrieve.
- **Projects, tasks, and workspace tree** — projects can contain multiple independent
  tasks. The Workspace view starts at the project root and expands folders on demand,
  making larger repositories easier to inspect and edit.
- **Per-turn Anchor recovery** — assistant turns that changed files expose a compact
  Anchor action. The review surface lists affected files, additions/deletions, and exact
  text diffs before a two-step confirmation. Restore is atomic: if any file changed
  later, the entire turn remains untouched and the conflict is reported.
- **Safer long-task context** — provider token usage calibrates the estimator when
  available; scoped rules and durable project knowledge are re-injected after structured
  compaction, and relevant history can be recalled without replaying the whole task.

## Downloads

- `AporiaX-Setup-0.4.1-x64.exe` — standard Windows installer.
- `AporiaX-Portable-0.4.1-x64.exe` — portable build, no installation required.

## SHA-256

```text
AB1211C3C018E5F395AD3C5801D6BDA1DABC7DDB0F490BBDBCC35C768853F69D  AporiaX-Setup-0.4.1-x64.exe
722950810A60DBE32BF5F1F0CB07D8D232508F664C0550BE042BD401783441C7  AporiaX-Portable-0.4.1-x64.exe
```

## Validation

- P0 model smoke tests
- runtime smoke tests, including Anchor restore and conflict safety
- Node syntax checks for Electron runtime modules
- Vite production build
- Electron Builder Windows installer and portable packaging

## Important notes

- AporiaX remains a preview. Review important changes and keep source control or backups
  for valuable workspaces.
- The default local sandbox isolates workspace mutations through a temporary copy, but
  still uses the current user's host network and process permissions. Enable Docker for
  stronger, network-disabled OS-level isolation.
- Windows packages are not code-signed with a trusted publisher certificate, so
  SmartScreen may display a warning.
- API keys are encrypted through Electron `safeStorage`; never paste real credentials
  into source files, issues, or logs.

---

# AporiaX 0.4.1 中文说明

AporiaX 0.4.1 是面向 Windows x64 的预览版本。它把桌面端从单线程工具循环升级为可观察的
项目级 Agent 系统：长任务可以分派给子 Agent、由 Witness 持续记录、分阶段自检、在项目任务间
共享理解，并精确回退产生修改的某一轮对话。

## 主要更新

- **并行子 Agent**：Explore、Review、Verify 使用独立上下文、范围受限的工具和对应权限；
  独立读取与检索可以并行执行，大规模探索不会继续挤占主 Agent 上下文。
- **Witness 与新版 Route**：Witness 记录主/子 Agent 动作、耗时、失败、审批与自检阶段；
  Dialogue 展示当前进度，Route 将证据整理为可展开的理解、探索、执行和验证阶段。
- **分段自检与最终封印**：Review/Verify 子 Agent 在工作过程中按当前文件版本完成复核；
  最终阶段只确认覆盖范围、测试证据、交付物和剩余风险，不再机械重读全部文件。
- **版本化 Project Understanding**：一个工作区对应一个项目；架构、约定、已验证命令、
  用户偏好和调试经验会被整理为可追溯的共享理解，供项目中的不同任务自动检索。
- **项目、任务与文件树**：一个项目可以包含多个独立任务；Workspace 默认只显示根目录，
  文件夹按需展开，便于检查和编辑大型项目。
- **对话级 Anchor**：产生文件修改的回复旁会显示 Anchor。用户可以先查看文件清单、增删行
  与具体 Diff，再经过二次确认原子回退；任何后续修改都会让回退安全停止，不覆盖当前文件。
- **更可靠的长任务上下文**：模型提供 usage 时自动校准 Token 估算；压缩后重新注入目录规则
  和项目知识，并按当前任务召回相关历史，而不是重放全部对话。

## 下载

- `AporiaX-Setup-0.4.1-x64.exe`：标准 Windows 安装版。
- `AporiaX-Portable-0.4.1-x64.exe`：无需安装的便携版。

当前版本仍处于 Preview 阶段。默认本地沙箱通过临时工作区副本隔离文件修改，但仍使用当前
用户的网络与进程权限；需要更强系统隔离时请启用 Docker。Windows 包尚未使用受信任发布者
证书签名，因此系统可能显示 SmartScreen 提示。

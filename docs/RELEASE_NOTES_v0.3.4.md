# AporiaX 0.3.4

> Every problem begins with an aporia.

AporiaX 0.3.4 is a Windows x64 preview focused on identity, durable local execution,
and a calmer workspace experience.

## Highlights

- **New AporiaX identity** — the authored AporiaX icon now appears across the app,
  Windows package, browser favicon, README, and About view.
- **Local sandbox by default** — commands can run automatically in a temporary
  workspace copy and synchronize changes back after conflict checks. Docker remains
  optional for stronger, network-disabled OS-level isolation.
- **Durable runs and recovery** — persisted run records, resumable interrupted tasks,
  queued follow-ups, live steering, and Anchor checkpoints make longer work safer.
- **Route, Evidence, Anchor** — clearer execution paths, visible command evidence,
  editable review surfaces, and reversible file changes.
- **Refined interface** — updated Settings and New Task surfaces, brighter AporiaX blue
  accents, larger Workspace and diff typography, and improved Route command display.
- **OpenAI-compatible providers** — configure multiple API providers and model IDs,
  discover models where supported, and select a model for each task.

## Downloads

- `AporiaX-Setup-0.3.4-x64.exe` — standard Windows installer.
- `AporiaX-Portable-0.3.4-x64.exe` — portable build, no installation required.

## SHA-256

```text
113A5149E0D2D83B40BF7FF53D0619AF2040760208159633E5884B664BAF114B  AporiaX-Setup-0.3.4-x64.exe
2ED2C81DDF3567F9867F4446DBAE06AB5D8E37CA1053F22A84A739ABDA4DBDAC  AporiaX-Portable-0.3.4-x64.exe
```

## Important notes

- AporiaX is still a preview. Review important file changes before accepting them.
- The local sandbox isolates workspace changes but uses the current user's network and
  process permissions. Enable Docker when stronger isolation is required.
- Windows packages are currently unsigned, so Windows may display a SmartScreen warning.
- API keys are encrypted through Electron `safeStorage`; never paste real credentials
  into source files, issues, or logs.

---

# AporiaX 0.3.4 中文说明

AporiaX 0.3.4 是面向 Windows x64 的预览版本，本次重点更新品牌识别、持久化本地执行
与更克制的工作区体验。

## 主要更新

- 全面启用新版 AporiaX 图标，覆盖应用、Windows 安装包、网页图标、README 与关于页。
- 本地沙箱默认自动执行；Docker 保留为可选的断网、系统级加强隔离层。
- 加入持久化运行记录、跨轮恢复、排队追问、即时纠偏与 Anchor 回退锚点。
- Route 展示实际命令与行动依据，审核页面支持编辑、保存和安全撤销。
- 优化设置、新建任务、Workspace、Route 和代码 Diff 的配色与可读性。
- 支持多个 OpenAI-compatible Provider、模型发现与任务级模型选择。

当前版本仍处于 Preview 阶段。重要修改请在接受前完成审核；Windows 安装包尚未签名，
系统可能显示 SmartScreen 提示。

<p align="center">
  <img src="build/icon.png" width="88" alt="AporiaX" />
</p>

<h1 align="center">AporiaX</h1>

<p align="center">
  <strong>简体中文</strong> · <a href="README_EN.md">English</a>
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

AporiaX 是一个 **local-first 桌面 Coding Harness**。它不只让一个 Agent 在聊天框里循环调用工具，而是围绕一个拥有最终决策权的 **Main Agent**，按任务复杂度自适应组织 Explore、Builder、Review、Verify、Curator 与 Witness，把模糊需求转化为可观察、可验证、可回退的真实工程过程。

它可以直接操作授权工作区、编辑代码、运行验证、生成真实 Office 文件，并把行动路径、工具证据、文件修改、冲突检查和最终产物留在界面中。

> [!IMPORTANT]
> AporiaX `v0.5.0` 仍处于 Preview 阶段，当前提供 Windows x64 构建。
> 关闭主窗口时，正在运行的任务会继续留在 Electron 进程中并收至系统托盘；**完全退出进程后任务不会继续运行，也尚不支持重启后恢复正在执行的任务**。
> `run_command` 默认在本地临时工作区副本中执行并通过冲突检查同步改动。Docker 完全可选；启用后会升级为默认断网、只读系统的 OS 级强隔离。

- **Route**：展示任务真正发生过的步骤，而不是把执行藏在聊天文字背后。
- **Evidence**：保留工具调用、文件修改、验证结果、失败原因与协作证据。
- **Anchor**：把可恢复检查点带到每一轮对话旁，支持 Diff 预览、冲突检查和安全回退。

## 0.5.0：从 Agent 系统走向自适应 Multi-Agent Harness

`v0.5.0` 是 AporiaX 目前最重要的一次 Harness 架构升级。重点不是“同时开更多 Agent”，而是让额外 Agent **只在值得的时候出现，并且在明确边界内协作**。

### Adaptive Agent Budget

简单问题不会为了“多 Agent”而额外烧 Token：Main 可以直接完成。随着任务出现跨模块修改、探索、审查、自检或明确委派需求，Harness 才会逐步开放额外预算。

- 简单任务可以保持 **Main-only**。
- 复杂只读任务可以委派 Explore / Review / Verify。
- 符合条件的大型写任务最多启用 **2 个 Builder**。
- Agent 数量、并发数和角色容量都有硬上限，不提供无限制团队聊天。

### Main + Builder：并行，但不抢最终控制权

Builder 不是第二个 Main。Main 始终负责拆解、集成、处理共享边界并给出最终交付。

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

每个 Builder 在独立 Git worktree 中工作，并受到 **Scope Lease** 约束：

- 写入范围在任务开始前显式确定。
- 超出 scope 的改动在合入真实工作区前直接拒绝。
- Builder 不允许递归委派 Agent，也不能任意扩大自己的权限。
- 合并前会检查基线与并发修改；用户/Main 同时改过的文件不会被静默覆盖。
- 真实工作区存在未提交改动时，会使用 dirty-workspace overlay 保留现状并进行冲突安全集成。

### Collaboration v1：先约定，再并行

两个 Builder 即使没有编辑同一个文件，也可能在 API、UI、Schema 或状态语义上互相打架。0.5.0 因此加入了协作层：

- **Shared Contract**：把跨 Builder 必须共同遵守的 UI、API、Schema、State、安全和验收不变量写成共享契约。
- **Plan Approval**：只有 scope、依赖、Contract key 和共享文件责任都明确后，才允许并行执行。
- **Structured Handoff**：Builder 结束时必须交付摘要、假设、Main 待处理事项、Contract assertions 与消息。
- **Bounded Mailbox**：支持问题、通知和 blocker，但避免无限制的 peer-to-peer 对话消耗上下文。
- **Semantic disagreement detection**：在 Builder wave 之后检查跨 Builder 的语义不一致，再由 Main 决定如何集成。

### Review / Verify / Witness：质量链路仍然独立

0.5.0 保留并强化了 AporiaX 原有的可观察自检流程：

- **Review** 检查语义、实现和静态问题。
- **Verify** 关注 build、test、lint、typecheck 与运行时证据。
- **Witness** 只观察，不修改文件；持续记录 Main、子 Agent、耗时、失败与协作状态。
- Review / Verify 会匹配当前文件版本，避免拿旧版本结果为新代码背书。

### Harness Architecture v1

底层也开始从巨型 Runtime 向可演进 Harness 拆分：

- Event Bus + Hook API
- Declarative Agent Definition
- Session / Scheduler / Context / Tool / Review 等明确边界
- Plugin API
- loopback-only Core Server / Desktop Client 基础

当前 Core HTTP `taskRpc` 仍然关闭；0.5.0 先建立结构，不宣称已经成为可在桌面进程退出后继续执行的独立 daemon。

### Windows 后台任务体验

0.5.0 同时补齐了桌面端最实际的一块体验：

- 点击关闭按钮时隐藏到 Windows 系统托盘，而不是中断正在执行的任务。
- 托盘可以恢复窗口，也提供真正的 **Exit AporiaX**。
- Dialogue 显示任务已运行时间；托盘状态也会实时更新 elapsed runtime。
- 隐藏状态下完成任务会发送 Windows/Electron 系统通知。
- 首次关闭到托盘时会显示一次说明，避免用户误以为应用已经退出。
- 重复的应用内“Task completed”通知被抑制，系统通知作为后台完成的主要提示。

[查看完整的 0.5.0 中英双语发布说明](docs/RELEASE_NOTES_v0.5.0.md)

## 下载

| Windows x64 | 适合场景 |
| --- | --- |
| [下载安装版 0.5.0](https://github.com/CaptainLand/AporiaX/releases/download/v0.5.0/AporiaX-Setup-0.5.0-x64.exe) | 正常安装、桌面快捷方式与开始菜单 |
| [下载便携版 0.5.0](https://github.com/CaptainLand/AporiaX/releases/download/v0.5.0/AporiaX-Portable-0.5.0-x64.exe) | 不安装，直接运行和试用 |
| [查看 GitHub Release](https://github.com/CaptainLand/AporiaX/releases/tag/v0.5.0) | Release Notes、校验文件与构建产物 |

## 看见 Agent 真正在做什么

<table>
  <tr>
    <td width="50%"><img src="docs/assets/welcome.png" alt="AporiaX 粒子海欢迎页" /></td>
    <td width="50%"><img src="docs/assets/about.png" alt="AporiaX Route Evidence Anchor" /></td>
  </tr>
  <tr>
    <td align="center"><strong>从一个疑问开始</strong><br><sub>开屏与中英双语入口</sub></td>
    <td align="center"><strong>Route · Evidence · Anchor</strong><br><sub>看见路径，保留依据，随时安全回退</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/dialogue.png" alt="AporiaX Dialogue 对话与自检" /></td>
    <td width="50%"><img src="docs/assets/route.png" alt="AporiaX Route 行动路径" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Dialogue</strong><br><sub>任务、自检、产物与继续追问留在同一工作流</sub></td>
    <td align="center"><strong>Route</strong><br><sub>逐步查看工具、文件、命令、耗时与具体修改</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/workspace.png" alt="AporiaX Workspace 文件树与 Anchor" /></td>
    <td width="50%"><img src="docs/assets/understanding.png" alt="AporiaX Project Understanding 项目共享理解" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Workspace</strong><br><sub>按目录展开项目文件，预览代码并管理跨轮 Anchor</sub></td>
    <td align="center"><strong>Understanding</strong><br><sub>版本化沉淀架构、约定、命令、偏好与调试经验</sub></td>
  </tr>
</table>

## 当前能力

| 能力 | 当前实现 |
| --- | --- |
| 自适应 Agent 拓扑 | Adaptive Agent Budget；简单任务 Main-only，复杂任务按需开放 Explore / Review / Verify / Curator / Builder |
| 并行 Builder | 最多 2 个可写 Builder；Scope Lease、隔离 Git worktree、dirty overlay、冲突安全合并 |
| 协作契约 | Shared Contract、Plan Approval、structured handoff、bounded mailbox、语义分歧检测 |
| 代码与工作区 | 文件树、搜索、预览、编辑、`Ctrl+S`、精确 Patch、Git status / diff |
| 可观察执行 | Witness + Route 持续记录 Agent、工具、耗时、失败、自检与协作证据 |
| 审核与回退 | 文件快照、逐行 Diff、Office 二进制检查点、对话级 Anchor、原子冲突检查 |
| 文档生产 | 生成真实 `.docx`、`.pptx`、`.xlsx`，并进行结构化复核 |
| 项目理解 | Understanding 持续沉淀架构、约定、命令、偏好和调试经验 |
| 多模型 API | 多个 OpenAI-compatible Provider、多个密钥、`/models` 自动发现、任务级模型选择 |
| 桌面后台 | 关闭到托盘、后台继续任务、系统完成通知、任务 elapsed runtime |
| 权限与执行 | `allow` / `ask` / `deny`；本地工作区沙箱自动执行，Docker 可选加强隔离 |
| 中英双语 | 开屏与设置页即时切换；界面和新回复跟随语言 |

扫描版 PDF 会被识别为“需要 OCR”，但当前尚未内置 OCR 引擎。图片是否发送取决于所选 Provider 模型的视觉能力。

## 快速开始

首次启动后：

1. 新建任务并选择本地工作目录。
2. 添加一个 OpenAI-compatible API Provider 与模型。
3. 描述目标；AporiaX 会根据任务复杂度自动选择 Main-only 或受限的多 Agent 拓扑。
4. 在 Dialogue / Route 中查看工具、Builder、Review、Verify、文件修改与最终产物。

Docker Desktop 是可选项。未启用时，命令默认在临时工作区副本中执行，并通过冲突检查同步修改；启用后则进入默认断网、只读系统的容器沙箱，获得更强的 OS 级隔离。

## 从源码运行

需要 Node.js 20 或更高版本。

```powershell
git clone https://github.com/CaptainLand/AporiaX.git
cd AporiaX
npm install
npm run dev
```

首次使用时，在“模型 Provider”中添加 API Base URL 和 API Key。API Key 使用 Electron `safeStorage` 加密，不返回渲染进程。不要把真实密钥写入源码、`.env`、Issue 或日志。

## 常用命令

```powershell
# 开发
npm run dev

# 0.5.0 主要 smoke / regression gate
npm run test:desktop-background
npm run test:collaboration
npm run test:harness-v2
npm run test:architecture
npm run test:cache
npm run test:runtime

# Web 生产构建
npm run build

# Windows Setup + Portable
npm run dist:win
```

## 架构文档

- [Harness Architecture v1](docs/HARNESS_ARCHITECTURE_V1.md)
- [Harness Architecture v2 / Builder orchestration](docs/HARNESS_ARCHITECTURE_V2.md)
- [Harness Collaboration v1](docs/HARNESS_COLLABORATION_V1.md)
- [Desktop Background v1](docs/DESKTOP_BACKGROUND_V1.md)
- [0.5.0 Release Notes / 发布说明](docs/RELEASE_NOTES_v0.5.0.md)
- [Changelog](CHANGELOG.md)

## 已知边界

- Core HTTP `taskRpc` 仍然关闭；凭据、审批、pause/resume 和 mutation control 仍在桌面 Runtime 内。
- 关闭到托盘会保持 Electron 进程存活，但任务尚不能跨“完全退出 / 重启”继续执行。
- 部分 legacy 只读子 Agent 路径仍通过 compatibility runtime 执行。
- Collaboration v1 有意不提供无限制的实时 peer-to-peer Agent 聊天。

## 参与贡献

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要公开披露真实凭据或漏洞细节。

## License

[MIT](LICENSE) © 2026 CaptainLand

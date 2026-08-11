<p align="center">
  <img src="build/icon.png" width="88" alt="AporiaX" />
</p>

<h1 align="center">AporiaX</h1>

<p align="center">
  <strong>简体中文</strong> · <a href="README_EN.md">English</a>
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

AporiaX 是一个 local-first 桌面 Agent，把模糊需求转化为可观察、可验证、可回退的
行动路径。它可以直接操作授权工作区、编辑代码、生成真实 Office 文件，并把每一步修改、
验证依据和最终产物留在界面中，而不是只给出一段聊天回复。

> [!IMPORTANT]
> AporiaX `v0.6.0` 仍处于 Preview 阶段，当前提供 Windows x64 构建。
> `run_command` 默认在本地临时工作区副本中自动执行，结束后通过冲突检查同步项目变更，
> 不需要逐条批准。Docker 完全可选；启用后会升级为默认断网、只读系统的 OS 级强隔离。
> 本地沙箱主要隔离工作区改动，仍使用当前用户的本机网络与进程权限。

- **Route**：展示每一次任务实际发生的步骤，而不是隐藏在聊天文字之后。
- **Evidence**：保留工具调用、文件修改、验证结果和失败原因。
- **Anchor**：把可恢复检查点带到每一轮对话旁，支持预览 Diff、冲突检查和安全回退。

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

## 现在的一些功能

| 能力 | 当前实现 |
| --- | --- |
| 代码与工作区 | 文件树、搜索、预览、编辑、`Ctrl+S`、精确 Patch、Git 状态与 Diff |
| 文档生产 | 生成真实 `.docx`、`.pptx`、`.xlsx`，并进行结构化复核 |
| 自适应多 Agent | Adaptive Agent Budget 按任务复杂度分配额外 Agent；简单任务保持 Main-only，复杂任务受限扩展 |
| Builder 编排 | 大型可写任务最多使用 2 个 Builder；Task Graph、Scope Lease、独立 Git worktree 与冲突安全合并 |
| Agent 协作 | Shared Contract、Plan Approval、结构化 handoff 与有界 mailbox；Main 保持最终集成权 |
| 可观察执行 | Witness 在 Dialogue 实时记录主/子 Agent、当前动作、耗时、失败与自检阶段；Route 保留完整路径 |
| 审核与回退 | 文件快照、逐行 Diff、Office 二进制检查点、对话级 Anchor、跨轮恢复与原子冲突检查 |
| 强制自检 | 分段 Review/Verify 子 Agent 复核当前文件版本，最后以轻量封印确认测试、风险和交付物 |
| 子 Agent 与上下文 | 并行读取与检索；独立 Explore、Review、Verify、Curator，以及受 Scope 约束的 Builder；目录级规则、结构化压缩和按需历史召回 |
| 桌面后台 | 关闭窗口时可收至系统托盘继续任务；托盘恢复/退出、Windows 完成通知、任务运行时间显示 |
| 项目理解 | 一个工作区对应一个项目；Understanding 持续沉淀架构、约定、命令、偏好和调试经验，供项目内任务共享 |
| 多模型 API | 多个 OpenAI-compatible Provider、多个密钥、`/models` 自动发现与任务级模型选择 |
| 中英双语 | 开屏与设置页即时切换；界面和新回复跟随语言，历史消息与文件保持原样 |
| 附件与解析 | PDF、Office、Markdown、代码和图片附件；PDF 本地文本提取 |
| 权限与执行 | `allow` / `ask` / `deny` 策略；本地工作区沙箱自动执行，Docker 可选加强隔离 |

扫描版 PDF 当前会被识别为“需要 OCR”，但尚未内置 OCR 引擎。图片是否发送由每个
Provider 模型的视觉能力决定。

## 下载

| Windows x64 | 适合场景 |
| --- | --- |
| [下载安装版 0.6.0](https://github.com/CaptainLand/AporiaX/releases/download/v0.6.0/AporiaX-Setup-0.6.0-x64.exe) | 正常安装、桌面快捷方式与开始菜单 |
| [下载便携版 0.6.0](https://github.com/CaptainLand/AporiaX/releases/download/v0.6.0/AporiaX-Portable-0.6.0-x64.exe) | 不安装，直接运行和试用 |

### 0.6.0 更新：从功能累积到可扩展的本地 Agent 平台

- **架构重构**：对话界面迁移为原生 React，TaskStore 成为渲染层唯一状态源；Run/Turn Coordinator、纯事件 Reducer 和模块化 Runtime 统一任务生命周期。
- **统一能力系统**：原生工具、Office、Browser、Skill 与 MCP 进入同一个 Capability Registry，Route 与权限界面从能力元数据生成，不再依赖散落的硬编码。
- **Skill / MCP 扩展中心**：加入中英文扩展库、安装与配置流程、来源策略、启停控制和权限说明，可连接受信任的本地或远程 MCP Server。
- **更可靠的多 Agent**：Builder、Explore、Review、Verify 与 Curator 使用明确作用域；渐进式自检支持最多两个受控检查 Worker，并以当前文件版本和有效证据完成最终封印。
- **Witness 与长命令治理**：运行过程成为可保留的行动记录；Witness 会识别长期无进展命令、提醒 Main 调整策略，并在上限到达时清理进程树。
- **Understanding 自主沉淀**：Curator 根据任务证据判断是否值得写入共享理解，只保存可复用的架构、约定、命令、偏好和调试经验。
- **本地沙箱与恢复**：Docker 不再是命令执行前提；本地临时工作区提供自动执行、敏感变量过滤、冲突检查与安全同步，同时修复跨任务污染、停止恢复和重试残留状态。
- **Browser、视觉与工作区上下文**：新增隔离 Browser 工具、视觉代理、文件 `@mention`、稳定实时状态、长提示折叠与更低开销的流式渲染。

[查看 0.6.0 GitHub Release](https://github.com/CaptainLand/AporiaX/releases/tag/v0.6.0) · [查看完整更新记录](CHANGELOG.md)

首次启动后：

1. 新建任务并选择本地工作目录。
2. 添加一个 OpenAI-compatible API Provider 与模型。
3. 描述目标，查看 Route、文件修改、自检和最终产物。

Docker Desktop 是可选项。未启用时，命令默认在临时工作区副本中自动执行，并通过冲突
检查同步修改；启用后则进入默认断网、只读系统的容器沙箱，获得更强的 OS 级隔离。

## 从源码运行

需要 Node.js 20 或更高版本。若希望使用容器化 `run_command`，还需要启动 Docker Desktop；
应用内点击“准备 Docker 沙箱”会构建 `aporiax-sandbox:0.1` 本地镜像。
未启动 Docker 时仍可在本地临时工作区副本中自动执行命令，但会使用当前用户的网络与
进程权限，因此需要更强隔离时应启用 Docker。

```powershell
git clone https://github.com/CaptainLand/AporiaX.git
cd AporiaX
npm install
npm run dev
```

首次使用时在“模型 Provider”中添加 API Base URL 和 API Key。AporiaX 支持
OpenAI-compatible Chat Completions 接口，会尝试通过 `/models` 识别模型，也允许
手动输入模型 ID。可以同时保存多个 Provider，并让不同任务使用不同模型。

为兼容旧版本，DeepSeek 也可以通过环境变量提供：

```powershell
$env:DEEPSEEK_API_KEY="your-api-key"
npm start
```

API Key 使用 Electron `safeStorage` 加密，不返回渲染进程。不要把真实密钥写入源码、
`.env`、Issue 或日志。

## 常用命令

```powershell
# 开发模式：同时启动 Vite 与 Electron
npm run dev

# 运行时与 P0 数据模型测试
npm run test:runtime
npm run test:p0

# Harness / Collaboration / Desktop smoke tests
npm run test:architecture
npm run test:collaboration
npm run test:harness-v2
npm run test:desktop-background

# Web 生产构建
npm run build

# 构建 Windows 安装版和便携版
npm run dist:win
```

## 生成 Office 文件

新建“工作区读写”任务并绑定工作目录，然后直接描述目标：

```text
生成一份项目周报.docx，包含标题、进展要点、风险和里程碑表格。
```

```text
生成一份 6 页的季度复盘.pptx，并创建带增长率公式的销售看板.xlsx。
```

Harness 会使用结构化 Office 工具生成文件，再重新解析文档块、幻灯片、工作表和公式。
当前结构复核不能替代 Word、PowerPoint 或 Excel 中的最终视觉检查。

## 子 Agent 与项目上下文

AporiaX 会并行执行互不依赖的只读工具，并把较大的探索、审查和验证任务委派给拥有
独立上下文与路径范围的 Explore、Review、Verify 子 Agent。Curator 负责明确的持久项目理解；
对于满足条件的大型可写 Git 工作区任务，Harness 最多可规划 2 个 Builder，在独立 Git
worktree 中按 Scope Lease 写入，再由 Main 在冲突检查通过后集成。Builder 不能扩大写入范围、
执行任意命令或递归委派 Agent。

并行 Builder 在执行前需要通过 Shared Contract 与 Plan Approval，共享跨模块不变量、
验收条件和 Main 所有的共享文件边界；完成后通过结构化 handoff 和有界 mailbox 回传结果。
Main 保持最终集成权，Witness 只观察和记录。

Harness 支持以下项目规则：

- 工作区根目录和子目录中的 `AGENTS.md`、`APORIAX.md`、`DEEPAGENT.md`。
- `.aporiax/rules/*.md` 路径规则；可在 frontmatter 中使用 `paths` glob。
- 应用用户目录中的项目记忆，用于保存已验证命令、架构约定和明确偏好；凭据会被拒绝。

```markdown
---
paths:
  - src/**/*.js
---
修改 JavaScript 后运行项目的语法检查。
```

上下文接近模型窗口时，Harness 会保留系统与目录规则，将旧内容压缩成结构化 checkpoint，
再按当前任务检索相关约束、证据和项目记忆。若 Provider 返回实际 token usage，估算器会
自动校准；模型配置也可以提供 `contextWindow`。

运行任务时，Dialogue 底部的 **Witness** 会订阅 Harness 事件流，实时展示主 Agent 与
子 Agent 正在处理的动作。Witness 本身只观察和记录，不修改文件；操作耗时超过阈值或
同一工具连续失败时会显示提醒，完整工具证据仍保留在 Route。

## 项目级权限

工作区根目录可以添加 `.aporiax.json`：

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

配置只允许收紧任务权限，不能把只读任务提升为可写，也不能关闭 Harness 自检控制工具。

## 项目结构

```text
electron/   Electron 主进程、Harness、工具与安全边界
src/        React 界面、Route/Workspace 与审核体验
tests/      Runtime 和 P0 行为测试
docs/       架构与 Harness 路线图
build/      应用图标等构建资源
```

Harness 现状和后续计划见
[docs/HARNESS_ROADMAP.md](docs/HARNESS_ROADMAP.md)。本版本更新记录见
[CHANGELOG.md](CHANGELOG.md)。

## 参与贡献

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按
[SECURITY.md](SECURITY.md) 私下报告，不要公开披露真实凭据或漏洞细节。

## License

[MIT](LICENSE) © 2026 CaptainLand

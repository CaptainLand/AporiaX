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
  <a href="https://github.com/CaptainLand/AporiaX/tree/v0.6.5"><img alt="Source v0.6.5" src="https://img.shields.io/badge/source-v0.6.5-59a9cf"></a>
  <a href="https://github.com/CaptainLand/AporiaX/releases"><img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-202830?logo=windows"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-59a9cf.svg"></a>
</p>

<p align="center">
  <img src="docs/assets/aporiax-social-preview.jpg" width="100%" alt="AporiaX — Every problem begins with an aporia." />
</p>

AporiaX 是一个 local-first 桌面 Agent，把模糊需求转化为可观察、可验证、可回退的行动路径。它可以直接操作授权工作区、编辑代码、生成真实 Office 文件，并把每一步修改、验证依据和最终产物留在界面中，而不是只给出一段聊天回复。

> [!IMPORTANT]
> AporiaX 当前源码版本为 **`v0.6.5`**，仍处于 Preview 阶段，Windows x64 为当前打包目标。
> `v0.6.5` 的源码 Tag 已发布；在新的 0.6.5 GitHub Release 正式发布前，Releases 页面中的最新公开二进制仍可能是 `v0.6.1`。
> 0.6.5 将 Permission 与 Execution Mode 分离：是否允许执行由 Smart Permission 决定，在哪里执行则由 Direct / Safe / Isolated 决定。

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

## 0.6.5 更新：Execution、LSP 与完整 GitHub Agent 工作流

### Direct / Safe / Isolated

AporiaX 现在把“能不能执行”和“在哪里执行”拆成两个独立边界：

- **Direct**：直接在授权工作区执行，使用 Host 进程与网络权限，速度最快。
- **Safe**：在临时工作区副本中执行，完成后通过冲突检查同步回真实工作区；保护工作区改动，但仍使用 Host 进程与网络权限。
- **Isolated**：在 Docker 沙箱中执行，提供更强的 OS 级隔离；选择 Isolated 后不会静默回退到 Host。

Smart Permission 会在执行前做确定性的风险分类：低风险检查与常见 build/test/lint/type-check 可以自动通过；依赖变更、显式网络访问、远程写入和破坏性操作需要批准；明显的系统破坏命令会被拒绝。

### Persistent LSP

AporiaX 新增原生持久 LSP Runtime，支持：

- diagnostics
- definition
- references
- hover
- document symbols
- workspace symbols

TypeScript / JavaScript 语言服务随 AporiaX 提供；Python、Go、Rust、C/C++ 缺少语言服务器时，Agent 可以先检查状态，再通过显式批准的 `lsp_install` 安装 Pyright、gopls、rust-analyzer 或 clangd。

### Git / GitHub Agent workflow

AporiaX 可以从普通文件夹一路推进到可审查的 GitHub Pull Request，而不再要求用户先手动初始化 Git：

1. `git_init`
2. `git_status` / `git_diff` / `git_log`
3. 显式 `git_stage`
4. `git_commit`
5. `git_create_branch`
6. `git_remote_list` / `git_remote_add`
7. `git_pull` / `git_push`
8. `github_repo_create`
9. `github_pr_create`
10. `github_pr_view` / `github_pr_checks`

本地 Git 生命周期操作可以在 workspace-write 策略下自主执行；remote add、pull/push、GitHub 仓库创建和 PR 创建等外部副作用仍保持批准边界。Force push 不提供原生工具入口。

[查看完整 0.6.5 更新记录](docs/releases/v0.6.5.md) · [查看 v0.6.5 源码 Tag](https://github.com/CaptainLand/AporiaX/tree/v0.6.5)

## 现在的一些功能

| 能力 | 当前实现 |
| --- | --- |
| 代码与工作区 | 分页/按行读取、ripgrep 正则与 Glob 搜索、文件树、预览、编辑、多文件 Unified Patch、Git 状态与 Diff |
| 语言智能 | 持久 LSP：诊断、定义、引用、Hover、文档符号、工作区符号；支持受控安装缺失语言服务器 |
| Git / GitHub | 从 `git_init`、stage/commit/branch 到 remote、pull/push、创建仓库、创建 PR 与检查 CI |
| 权限与执行 | Smart Permission + Direct / Safe / Isolated；远程写入和高风险操作保持显式批准 |
| 文档生产 | 生成真实 `.docx`、`.pptx`、`.xlsx`，并进行结构化复核 |
| 自适应多 Agent | Adaptive Agent Budget 按任务复杂度分配额外 Agent；简单任务保持 Main-only，复杂任务受限扩展 |
| Builder 编排 | 大型可写任务最多使用 2 个 Builder；Task Graph、Scope Lease、独立 Git worktree 与冲突安全合并 |
| Agent 协作 | Shared Contract、Plan Approval、结构化 handoff 与有界 mailbox；Main 保持最终集成权 |
| 可观察执行 | Witness 在 Dialogue 实时记录主/子 Agent、当前动作、耗时、失败与自检阶段；Route 保留完整路径 |
| 审核与回退 | 文件快照、逐行 Diff、Office 二进制检查点、对话级 Anchor、跨轮恢复与原子冲突检查 |
| 强制自检 | 分段 Review/Verify 子 Agent 复核当前文件版本，最后以轻量封印确认测试、风险和交付物 |
| 项目理解 | Understanding 持续沉淀架构、约定、命令、偏好和调试经验，供项目内任务共享 |
| 扩展 | Skill 文件夹、MCP JSON、Browser、Office 与原生工具统一进入 Capability 系统 |
| 多模型 API | 多个 OpenAI-compatible Provider、多个密钥、`/models` 自动发现与任务级模型选择 |
| 桌面后台 | 关闭窗口时可收至系统托盘继续任务；托盘恢复/退出、Windows 完成通知、任务运行时间显示 |

扫描版 PDF 当前会被识别为“需要 OCR”，但尚未内置 OCR 引擎。图片是否发送由每个 Provider 模型的视觉能力决定。

## 下载

`v0.6.5` 源码已经固定在 Tag 中；新的 Windows 0.6.5 二进制将在 GitHub Release 发布后更新到这里。

| Windows x64 | 当前公开包 |
| --- | --- |
| [查看 Releases](https://github.com/CaptainLand/AporiaX/releases) | 安装版与便携版下载入口；发布 0.6.5 Release 后将更新为最新二进制 |
| [0.6.1 安装版](https://github.com/CaptainLand/AporiaX/releases/download/v0.6.1/AporiaX-Setup-0.6.1-x64.exe) | 当前已公开的稳定安装包 |
| [0.6.1 便携版](https://github.com/CaptainLand/AporiaX/releases/download/v0.6.1/AporiaX-Portable-0.6.1-x64.exe) | 当前已公开的便携包 |

首次启动后：

1. 新建任务并选择本地工作目录。
2. 添加一个 OpenAI-compatible API Provider 与模型。
3. 描述目标，查看 Route、文件修改、自检和最终产物。

## 从源码运行

需要 **Node.js 22.12.0 或更高版本**。

Docker Desktop 只在使用 Isolated 模式时是必需项；Direct 与 Safe 可以在不启动 Docker 的情况下运行。Safe 会使用临时工作区副本与冲突检查，Direct 则直接作用于授权工作区。

```powershell
git clone https://github.com/CaptainLand/AporiaX.git
cd AporiaX
npm install
npm run dev
```

首次使用时在“模型 Provider”中添加 API Base URL 和 API Key。AporiaX 支持 OpenAI-compatible Chat Completions 接口，会尝试通过 `/models` 识别模型，也允许手动输入模型 ID。可以同时保存多个 Provider，并让不同任务使用不同模型。

为兼容旧版本，DeepSeek 也可以通过环境变量提供：

```powershell
$env:DEEPSEEK_API_KEY="your-api-key"
npm start
```

API Key 使用 Electron `safeStorage` 加密，不返回渲染进程。不要把真实密钥写入源码、`.env`、Issue 或日志。

## 常用命令

```powershell
# 开发模式
npm run dev

# 0.6.5 核心验证
npm run test:runtime
npm run test:architecture
npm run test:execution-policy
npm run test:execution-wiring
npm run test:lsp
npm run test:lsp-installer
npm run test:github-workflow
npm run test:tool-permissions
npm run test:tool-dispatcher

# 生产构建
npm run build

# Windows 安装版与便携版
npm run dist:win
```

## 子 Agent 与项目上下文

AporiaX 会并行执行互不依赖的只读工具，并把较大的探索、审查和验证任务委派给拥有独立上下文与路径范围的 Explore、Review、Verify 子 Agent。Curator 负责持久项目理解；对于满足条件的大型可写 Git 工作区任务，Harness 最多可规划 2 个 Builder，在独立 Git worktree 中按 Scope Lease 写入，再由 Main 在冲突检查通过后集成。

并行 Builder 在执行前需要通过 Shared Contract 与 Plan Approval，共享跨模块不变量、验收条件和 Main 所有的共享文件边界；Main 保持最终集成权，Witness 只观察和记录。

Harness 支持工作区中的 `AGENTS.md`、`APORIAX.md`、`DEEPAGENT.md`，以及 `.aporiax/rules/*.md` 路径规则。项目 Understanding 用于保存已验证命令、架构约定和明确偏好；凭据会被拒绝。

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
tests/      Runtime 与行为验证
docs/       架构、版本说明与 Harness 路线图
build/      应用图标等构建资源
```

Harness 现状和后续计划见 [docs/HARNESS_ROADMAP.md](docs/HARNESS_ROADMAP.md)。完整版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 参与贡献

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要公开披露真实凭据或漏洞细节。

## License

[MIT](LICENSE) © 2026 CaptainLand

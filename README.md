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
  <a href="https://github.com/CaptainLand/AporiaX/tree/main"><img alt="Source v0.7.0" src="https://img.shields.io/badge/source-v0.7.0-59a9cf"></a>
  <a href="https://github.com/CaptainLand/AporiaX/releases"><img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-202830?logo=windows"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-59a9cf.svg"></a>
</p>

<p align="center">
  <img src="docs/assets/aporiax-social-preview.jpg" width="100%" alt="AporiaX — Every problem begins with an aporia." />
</p>

AporiaX 是一个 local-first 桌面 Agent，把模糊需求转化为可观察、可验证、可回退的行动路径。它可以直接操作授权工作区、编辑代码、生成真实 Office 文件，并把每一步修改、验证依据和最终产物留在界面中，而不是只给出一段聊天回复。

> [!IMPORTANT]
> AporiaX 当前源码版本为 **`v0.7.0`**，仍处于 Preview 阶段，Windows x64 为当前打包目标。
> `main` 已进入 0.7.0 源码状态；0.7.0 Windows 安装版与便携版会在单独完成打包后发布到 GitHub Releases。
> 0.7.0 首次把 Aporia Account、Aporia Cloud、DeepSeek V4 Flash / Pro 与 Cloud Vision 接成完整桌面链路，同时保留 BYOK 与本地模型路径。

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

## 0.7.0 更新：Aporia Account、Cloud 模型与原生视觉

### Aporia Account

桌面端现在可以通过系统浏览器登录 Aporia Account：

- 使用 PKCE S256 + 本地 loopback callback 完成 Desktop 授权；
- Access Token 只保留在 Electron Main 内存中；
- Refresh Token 使用 Electron `safeStorage` 加密后持久化；
- Renderer / preload 只看到投影后的账号状态，不接触原始 Token；
- 登录账号不会自动上传工作区源码、本地项目或本地对话。

### Aporia Cloud

模型选择器现在把模型来源明确分成 **Aporia Cloud / 你的 Provider / 本地**。

Aporia Cloud 当前提供：

- **DeepSeek V4 Flash**：默认托管模型；
- **DeepSeek V4 Pro**：可选的更高能力托管模型；
- 两者通过登录后的 Aporia Model Gateway 调用，不需要在桌面端保存 DeepSeek API Key；
- Cloud 与 BYOK / 本地模型保持独立，周额度用尽时不会静默切换到用户付费 API。

### Cloud Vision

Aporia Cloud 的图片理解通过隐藏的 Qwen3.5 Flash Vision 路径完成，而主 Agent 仍然使用 DeepSeek：

```text
图片附件 -> Qwen3.5 Flash Vision -> 精简文本观察 -> DeepSeek V4 -> Harness / Tool Loop
```

图片会在主 Agent 循环之前完成一次性理解，之后移除原始图片，后续工具轮次复用文本观察，不重复发送同一图片。Qwen Provider 凭据只存在 Cloud 侧。

### 隐私与体验收尾

- 桌面端为免费额度防滥用生成一个持久随机安装 UUID，不读取 MachineGuid、MAC、磁盘序列号等硬件指纹；Cloud 仅保存其 HMAC 哈希。
- 模型卡片文案更简洁，宽度统一，不再显示重复的“无需 API Key / 支持工具 / 支持图片”等标签。
- 本地模型不再被默认描述为支持图片；离线视觉需要用户自己配置本地视觉模型 / Runtime。
- 已完成任务的蓝色进展栏默认折叠，点击后会一次性完整展开全部保留进展，不再受固定像素高度限制。
- Cloud 暂时不可用时，左下角只显示安静的连接状态，不再堆叠红色网络报错。

[查看完整 0.7.0 更新记录](docs/releases/v0.7.0.md)

## 现在的一些功能

| 能力 | 当前实现 |
| --- | --- |
| 代码与工作区 | 分页/按行读取、ripgrep 正则与 Glob 搜索、文件树、预览、编辑、多文件 Unified Patch、Git 状态与 Diff |
| 语言智能 | 持久 LSP：诊断、定义、引用、Hover、文档符号、工作区符号；支持受控安装缺失语言服务器 |
| Git / GitHub | 从 `git_init`、stage/commit/branch 到 remote、pull/push、创建仓库、创建 PR 与检查 CI |
| 权限与执行 | Smart Permission + Direct / Safe / Isolated；远程写入和高风险操作保持显式批准 |
| Aporia Account | 系统浏览器授权、PKCE、Main-only Access Token、safeStorage Refresh Token、账号/额度/设备状态 |
| Aporia Cloud | 托管 DeepSeek V4 Flash / Pro、滚动周额度、Main-process Gateway、与 BYOK / Local 独立 |
| Cloud Vision | 显式图片附件经 Qwen3.5 Flash 一次性理解，再把文本观察交给 DeepSeek 主 Agent |
| 文档生产 | 生成真实 `.docx`、`.pptx`、`.xlsx`，并进行结构化复核 |
| 自适应多 Agent | Adaptive Agent Budget 按任务复杂度分配额外 Agent；简单任务保持 Main-only，复杂任务受限扩展 |
| Builder 编排 | 大型可写任务最多使用 2 个 Builder；Task Graph、Scope Lease、独立 Git worktree 与冲突安全合并 |
| Agent 协作 | Shared Contract、Plan Approval、结构化 handoff 与有界 mailbox；Main 保持最终集成权 |
| 可观察执行 | Witness 在 Dialogue 实时记录主/子 Agent、当前动作、耗时、失败与自检阶段；Route 保留完整路径 |
| 审核与回退 | 文件快照、逐行 Diff、Office 二进制检查点、对话级 Anchor、跨轮恢复与原子冲突检查 |
| 强制自检 | 分段 Review/Verify 子 Agent 复核当前文件版本，最后以轻量封印确认测试、风险和交付物 |
| 项目理解 | Understanding 持续沉淀架构、约定、命令、偏好和调试经验，供项目内任务共享 |
| 扩展 | Skill 文件夹、MCP JSON、Browser、Office 与原生工具统一进入 Capability 系统 |
| 多模型 API | Aporia Cloud、多个 OpenAI-compatible Provider、多个密钥、`/models` 自动发现与任务级模型选择 |
| 桌面后台 | 关闭窗口时可收至系统托盘继续任务；托盘恢复/退出、Windows 完成通知、任务运行时间显示 |

扫描版 PDF 当前会被识别为“需要 OCR”，但尚未内置 OCR 引擎。Aporia Cloud 图片附件可走 Cloud Vision；BYOK / 本地模型的图片能力取决于用户自己的视觉模型与配置。

## 下载

`main` 当前已经是 **v0.7.0 源码状态**。Windows x64 的 0.7.0 安装版与便携版会在完成打包后上传到 GitHub Releases。

| Windows x64 | 当前公开包 |
| --- | --- |
| [查看 Releases](https://github.com/CaptainLand/AporiaX/releases) | 安装版与便携版下载入口；0.7.0 二进制发布后会成为最新版本 |
| [0.6.1 安装版](https://github.com/CaptainLand/AporiaX/releases/download/v0.6.1/AporiaX-Setup-0.6.1-x64.exe) | 当前已公开的稳定安装包 |
| [0.6.1 便携版](https://github.com/CaptainLand/AporiaX/releases/download/v0.6.1/AporiaX-Portable-0.6.1-x64.exe) | 当前已公开的便携包 |

首次启动后：

1. 新建任务并选择本地工作目录。
2. 登录 AporiaX 使用 Aporia Cloud，或者添加自己的 OpenAI-compatible / 本地 Provider。
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

首次使用时可以登录 Aporia Account 使用 Aporia Cloud，也可以在“模型 Provider”中添加 API Base URL 和 API Key。AporiaX 支持 OpenAI-compatible Chat Completions 接口，会尝试通过 `/models` 识别模型，也允许手动输入模型 ID。可以同时保存多个 Provider，并让不同任务使用不同模型。

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

# 0.7.0 核心验证
npm run test:runtime
npm run test:architecture
npm run test:execution-policy
npm run test:execution-wiring
npm run test:lsp
npm run test:github-workflow
npm run test:account-ui
npm run test:cloud-model
npm run test:vision
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
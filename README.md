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
  <a href="https://github.com/CaptainLand/AporiaX/tree/main"><img alt="Source v0.9.8" src="https://img.shields.io/badge/source-v0.9.8-59a9cf"></a>
  <a href="https://github.com/CaptainLand/AporiaX/releases"><img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-202830?logo=windows"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-59a9cf.svg"></a>
</p>

<p align="center">
  <img src="docs/assets/aporiax-social-preview.jpg" width="100%" alt="AporiaX — Every problem begins with an aporia." />
</p>

AporiaX 是 Windows 上的本地优先桌面 Agent。它在你授权的工作区里改代码、跑命令、生成 Word / PPT / Excel；对话和文件、浏览器、终端、Git 在同一屏，步骤、依据和回退都留在界面里，而不是只给一段聊天回复。

> [!IMPORTANT]
> 当前源码与 Windows 发行为 **`v0.9.8` Preview**。
> 本版加固任务历史和文件写入，Builder / Safe 更稳；OCR 引擎仍在，输入栏入口暂时隐藏。
> Aporia Account、Aporia Cloud、自己的 API 与本地模型相互独立，额度用尽不会偷偷切到另一条路径。
> 安装包未代码签名。请先退出旧版再更新。

## 现在能做什么

- **授权工作区**：分页/按行读取、搜索、文件树、预览、编辑、多文件补丁；可选 LSP 诊断与跳转。
- **同屏工作台**：文件、内置 Browser、终端、Git、侧边聊天与对话在同一窗口。Agent 用 `present_to_user` 打开侧栏；回答里的链接不会自动弹页。
- **Git**：查看改动、暂存、提交、分支、初始化/克隆、远程与 GitHub 登录。普通 UTF-8 merge 冲突可在侧栏对比编辑；当前分支的 PR 和检查只读查看。
- **执行边界**：Direct 直接改工作区；Safe 用工作区副本，不写宿主 `node_modules`；Isolated 走 Docker，没有 Docker 就拒绝，不静默降级。高风险操作仍要批准。
- **模型**：登录使用托管 DeepSeek V4 Flash / Pro，或添加 OpenAI-compatible / 本地 Provider。Cloud 图片附件可走 Cloud Vision；自己的模型看你是否配置了视觉能力。
- **文档与扩展**：生成真实 `.docx` / `.pptx` / `.xlsx`。Skill 与 MCP 进同一套能力系统，安装前可看来源和许可。
- **看见与回退**：Route 记录实际步骤，Witness 跟踪进行中的动作，Anchor 可预览 Diff 并安全回退工作区文件。
- **桌面**：任务可收到系统托盘继续跑；安装版可在应用内检查 GitHub 更新。

本地 OCR 引擎仍保留（中英文，首次下载语言模型），界面按钮先不放出。完整能力与边界见 [SECURITY.md](SECURITY.md)。

<table>
  <tr>
    <td width="50%"><img src="docs/assets/welcome.png" alt="AporiaX 浅色 Gem Smoke 欢迎页" /></td>
    <td width="50%"><img src="docs/assets/about.png" alt="AporiaX 设置 · 关于" /></td>
  </tr>
  <tr>
    <td align="center"><strong>从一个疑问开始</strong><br><sub>浅色开屏与中英入口</sub></td>
    <td align="center"><strong>看见路径，随时回退</strong><br><sub>Route · Evidence · Anchor</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/dialogue.png" alt="AporiaX Dialogue 对话与自检" /></td>
    <td width="50%"><img src="docs/assets/route.png" alt="AporiaX Route 行动路径" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Dialogue</strong><br><sub>任务、自检、产物与追问</sub></td>
    <td align="center"><strong>Route</strong><br><sub>工具、文件、命令与具体修改</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/workspace.png" alt="AporiaX Workspace 文件树与 Anchor" /></td>
    <td width="50%"><img src="docs/assets/understanding.png" alt="AporiaX Project Understanding 项目共享理解" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Workspace</strong><br><sub>文件树、预览与 Anchor</sub></td>
    <td align="center"><strong>Understanding</strong><br><sub>项目内共享的架构与约定</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/settings-general.png" alt="AporiaX 通用设置" /></td>
    <td width="50%"><img src="docs/assets/settings-extensions.png" alt="AporiaX 扩展库" /></td>
  </tr>
  <tr>
    <td align="center"><strong>通用设置</strong><br><sub>语言、外观、模型与执行边界</sub></td>
    <td align="center"><strong>扩展</strong><br><sub>可审查的 Skill 与 MCP</sub></td>
  </tr>
</table>

## 0.9.8

- 任务历史更不容易写丢：部分迁移可重试并保留原件，损坏记录不挡住其余任务，删除会归档。
- 普通写文件、补丁和 Office 与 Builder 合并共用可恢复提交。
- Builder 走委派快照与合并；并发可选 0–6，默认 2。Safe 在同一任务的成功命令之间保留私有依赖。
- OCR 改到可终止子进程；输入栏、附件和侧栏按钮暂时隐藏。
- 特权操作校验主窗口来源；MCP 超时/取消不把远端副作用说成已经撤销。

[完整 0.9.8 说明](docs/RELEASE_NOTES_v0.9.8.md) · [更新历史](CHANGELOG.md)

## 下载

`main` 当前是 **v0.9.8**。Windows x64 安装版与便携版在 GitHub Releases。

| Windows x64 | 当前公开包 |
| --- | --- |
| [查看 Releases](https://github.com/CaptainLand/AporiaX/releases) | 历史版本与发行说明 |
| [0.9.8 安装版](https://github.com/CaptainLand/AporiaX/releases/download/v0.9.8/AporiaX-Setup-0.9.8-x64.exe) | 推荐 |
| [0.9.8 便携版](https://github.com/CaptainLand/AporiaX/releases/download/v0.9.8/AporiaX-Portable-0.9.8-x64.exe) | 无需安装 |

第一次使用：

1. 新建任务并选择本地工作目录。
2. 登录 Aporia Account 使用 Aporia Cloud，或添加自己的 OpenAI-compatible / 本地 Provider。
3. 描述目标，查看 Route、文件修改、自检和产物。

## 从源码运行

需要 **Node.js 22.12.0 或更高版本**。Docker Desktop 只在 Isolated 模式需要；Direct 与 Safe 可以不装 Docker。

```powershell
git clone https://github.com/CaptainLand/AporiaX.git
cd AporiaX
npm install
npm run dev
```

API Key 用 Electron `safeStorage` 加密，不回到渲染进程。不要把真实密钥写进源码、`.env`、Issue 或日志。旧版 DeepSeek 仍可用环境变量 `DEEPSEEK_API_KEY`。

```powershell
npm run dev          # 开发
npm run build        # 生产渲染进程
npm run dist:win     # Windows 安装版与便携版
npm run test:audit-suite
```

## 子 Agent 与项目约定

只读探索、审查、验证可以交给独立子 Agent。可写的 Git 任务可委派 Builder：并发 **0 / 1 / 2 / 3 / 4 / 6，默认 2**，在独立 worktree 里按范围写入，冲突检查通过后由主 Agent 合入。

工作区识别 `AGENTS.md`、`APORIAX.md`、`DEEPAGENT.md` 以及 `.aporiax/rules/*.md`。Understanding 保存已验证命令、架构约定和明确偏好，拒绝写入凭据。

项目根目录可用 `.aporiax.json` **收紧**权限，不能把只读任务提升为可写：

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
electron/   主进程、Harness、工具与安全边界
src/        界面、工作台与审核
tests/      运行时与行为验证
docs/       架构与版本说明
build/      图标等构建资源
```

路线图：[docs/HARNESS_ROADMAP.md](docs/HARNESS_ROADMAP.md)。

## 参与贡献

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题按 [SECURITY.md](SECURITY.md) 私下报告。

## License

[MIT](LICENSE) © 2026 CaptainLand

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
  <a href="https://github.com/CaptainLand/AporiaX/tree/main"><img alt="Source v0.9.9" src="https://img.shields.io/badge/source-v0.9.9-59a9cf"></a>
  <a href="https://github.com/CaptainLand/AporiaX/releases"><img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-202830?logo=windows"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-59a9cf.svg"></a>
</p>

<p align="center">
  <img src="docs/assets/aporiax-social-preview.jpg" width="100%" alt="AporiaX — Every problem begins with an aporia." />
</p>

AporiaX 是 Windows 上的本地优先桌面 Agent。它在你授权的工作区里改代码、跑命令、生成 Word / PPT / Excel；对话和文件、浏览器、终端、Git 在同一屏，步骤、依据和回退都留在界面里，而不是只给一段聊天回复。

> [!IMPORTANT]
> 当前源码与 Windows 发行为 **`v0.9.9` Preview**。
> 本版重点改进 Harness 长任务记忆、失败恢复、进程等待与验收证据；严格重规划和原生模型协议按需开启。
> Aporia Account、Aporia Cloud、自己的 API 与本地模型相互独立，额度用尽不会偷偷切到另一条路径。
> 安装包未代码签名。请先退出旧版再更新。

## 现在的一些功能

| 能力 | 当前实现 |
| --- | --- |
| 代码与工作区 | 分页/按行读取、ripgrep 正则与 Glob 搜索、文件树、预览、编辑、多文件 Unified Patch、Git 状态与 Diff |
| 同屏工作台 | 文件、Browser、终端、Git、侧边聊天与对话同一窗口；由 Agent 调用 `present_to_user` 打开侧栏 |
| 语言智能 | 持久 LSP：诊断、定义、引用、Hover、文档符号、工作区符号；支持受控安装缺失语言服务器 |
| Git / GitHub | 从 init、stage/commit/branch 到 remote、pull/push、创建仓库；侧栏编辑普通 UTF-8 merge 冲突；只读查看当前分支 PR 与 CI |
| 权限与执行 | Smart Permission + Direct / Safe / Isolated；Safe 不写宿主 `node_modules`；Isolated 无 Docker 时拒绝，不静默降级 |
| Aporia Account | 系统浏览器授权、PKCE、Main-only Access Token、safeStorage Refresh Token、账号/额度/设备状态 |
| Aporia Cloud | 托管 DeepSeek V4 Flash / Pro、滚动周额度、Main-process Gateway，与 BYOK / Local 独立 |
| Cloud Vision | 显式图片附件经 Qwen3.5 Flash 一次性理解，再把文本观察交给 DeepSeek 主 Agent |
| 文档生产 | 生成真实 `.docx`、`.pptx`、`.xlsx`，并进行结构化复核 |
| 自适应多 Agent | Adaptive Agent Budget 按任务复杂度分配额外 Agent；简单任务保持 Main-only |
| Builder 编排 | 并发可选 0 / 1 / 2 / 3 / 4 / 6，默认 2；Task Graph、Scope Lease、独立 Git worktree 与冲突安全合并 |
| Agent 协作 | Shared Contract、Plan Approval、结构化 handoff 与有界 mailbox；Main 保持最终集成权 |
| 可观察执行 | Witness 在 Dialogue 实时记录主/子 Agent、当前动作、耗时、失败与自检阶段；Route 保留完整路径 |
| 审核与回退 | 文件快照、逐行 Diff、Office 二进制检查点、对话级 Anchor、跨轮恢复与冲突检查 |
| 独立检查 | 主 Agent 明确选择相关命令与审查；允许带着未验证/失败状态交付 |
| 项目理解 | Understanding 持续沉淀架构、约定、命令、偏好和调试经验，供项目内任务共享 |
| 扩展 | Skill 文件夹、MCP JSON、Browser、Office 与原生工具统一进入 Capability 系统 |
| 多模型 API | Aporia Cloud、多个 OpenAI-compatible Provider、多个密钥、`/models` 自动发现与任务级模型选择 |
| 桌面后台 | 关闭窗口时可收至系统托盘继续任务；托盘恢复/退出、Windows 完成通知、任务运行时间显示 |
| 本地 OCR | 中英文引擎仍在，首次下载语言模型；输入栏、附件和侧栏入口暂时隐藏 |

完整边界见 [SECURITY.md](SECURITY.md)。

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

## 0.9.9

- 长任务保留有来源的决策、否决方案和待确认问题；压缩上下文时保留关键诊断与结果引用。
- 主 Agent 与子 Agent 共用有序工具调度，后台进程可等待输出/退出事件，减少无效查询。
- 上下文溢出和不完整模型输出采用有限恢复；重复失败/来回修改触发重规划建议，严格预算可选。
- 可选验收契约只核对文件与已有命令证据，不自行启动项目测试，也不把未验证说成通过。
- 原生模型协议按 Provider 显式选择，兼容 Chat 默认路径不变；尚无真实模型 A/B 提速或成本结论。

[完整 0.9.9 说明与版本对比](docs/RELEASE_NOTES_v0.9.9.md) · [更新历史](CHANGELOG.md)

## 下载

`main` 当前是 **v0.9.9**。Windows x64 安装版与便携版在 GitHub Releases。

| Windows x64 | 当前公开包 |
| --- | --- |
| [查看 Releases](https://github.com/CaptainLand/AporiaX/releases) | 历史版本与发行说明 |
| [0.9.9 安装版](https://github.com/CaptainLand/AporiaX/releases/download/v0.9.9/AporiaX-Setup-0.9.9-x64.exe) | 推荐 |
| [0.9.9 便携版](https://github.com/CaptainLand/AporiaX/releases/download/v0.9.9/AporiaX-Portable-0.9.9-x64.exe) | 无需安装 |

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

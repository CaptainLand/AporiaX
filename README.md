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
  <a href="https://github.com/CaptainLand/AporiaX/tree/v1.0.0-preview.6"><img alt="Source v1.0.0-preview.6" src="https://img.shields.io/badge/source-v1.0.0--preview.6-59a9cf"></a>
  <a href="https://github.com/CaptainLand/AporiaX/releases"><img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-202830?logo=windows"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-59a9cf.svg"></a>
</p>

<p align="center">
  <img src="docs/assets/aporiax-social-preview.jpg" width="100%" alt="AporiaX — Every problem begins with an aporia." />
</p>

AporiaX 是 Windows 上的本地优先桌面 Agent。它在你授权的工作区里改代码、跑命令、生成 Word / PPT / Excel；对话和文件、浏览器、终端、Git 在同一屏，步骤、依据和回退都留在界面里，而不是只给一段聊天回复。

> [!IMPORTANT]
> 当前 Windows 预览版为 **1.0.0 Preview 6（`v1.0.0-preview.6`）**，不是 1.0.0 正式版。
> Cloud 按实际用量结算，不再预占个人额度；周额度剩余 5% 时进入收尾，耗尽后保存进度并暂停。头像展示及上传入口暂时关闭，源码和已有数据保留；文件、项目与对话后台同步保持关闭。Cloud 最低版本暂保留 Preview 4。
> 参见 [Preview 6 说明](docs/RELEASE_NOTES_v1.0.0-preview.6.md)。Cloud 暂限 20 人、全站每日 ¥5；独立 AporiaX Beta 需手动换包一次。
> 本版已作为普通 GitHub Release 设为 **Latest**，应用默认更新检测可发现；版本名仍保留 preview，已知问题见下文。
> 本版新增断网等待与睡眠唤醒续跑，完善主/子 Agent 协作、执行记录、按需项目知识与首次使用引导。
> Aporia Account、Aporia Cloud、自己的 API 与本地模型相互独立，额度用尽不会偷偷切到另一条路径。
> 安装包未代码签名。请先退出旧版再更新。

## 现在的一些功能

第一次使用？阅读 [中文使用教程](https://captainland.github.io/AporiaX_web/guide/)：从添加 API Key、验证连接开始，再了解侧栏、Git、项目知识与扩展。也可查看[教程 Markdown 文档](docs/USER_GUIDE.zh-CN.md)。

| 能力 | 当前实现 |
| --- | --- |
| 代码与工作区 | 分页/按行读取、ripgrep 正则与 Glob 搜索、文件树、预览、编辑、多文件 Unified Patch、Git 状态与 Diff |
| 同屏工作台 | 文件、Browser、终端、Git、侧边聊天与对话同一窗口；由 Agent 调用 `present_to_user` 打开侧栏 |
| 语言智能 | 持久 LSP：诊断、定义、引用、Hover、文档符号、工作区符号；支持受控安装缺失语言服务器 |
| Git / GitHub | 从 init、stage/commit/branch 到 remote、pull/push、创建仓库；侧栏编辑普通 UTF-8 merge 冲突；只读查看当前分支 PR 与 CI |
| 权限与执行 | Smart Permission + Direct / Safe / Isolated；Safe 不写宿主 `node_modules`；Isolated 无 Docker 时拒绝，不静默降级 |
| Aporia Account | 系统浏览器授权、PKCE、Main-only Access Token、safeStorage Refresh Token、账号/额度/设备状态 |
| Aporia Cloud | 单一托管 DeepSeek V4.1 Flash、原生图片、按高峰/非高峰价格折算滚动周额度，与 BYOK / Local 独立 |
| Cloud 图片 | 根据服务端能力使用 Flash 原生图片输入；旧 Qwen 图片代理已关闭，不偷偷切换模型 |
| 文档生产 | 生成真实 `.docx`、`.pptx`、`.xlsx`，并进行结构化复核 |
| 自适应多 Agent | Adaptive Agent Budget 按任务复杂度分配额外 Agent；简单任务保持 Main-only |
| Builder 编排 | 并发可选 0 / 1 / 2 / 3 / 4 / 6，默认 2；Task Graph、Scope Lease、独立 Git worktree 与冲突安全合并 |
| Agent 协作 | 主 Agent 传递原始要求，子 Agent 独立上下文与结构化结果；返回结果与主 Agent 验收分开，Builder 不运行 shell，验证由 Main / Verify 负责 |
| 可观察执行 | 执行记录按最新在前展示当前动作、详情和真实状态；逐轮统计 Main / Explore / Review / Verify / Curator / Builder 激活次数、Builder 并发/排队/峰值 |
| 暂停与恢复 | 临时断网等待，睡眠后唤醒续跑；主/子 Agent 共用暂停控制，保留已接收上下文与操作收据，不自动重放未知副作用 |
| 审核与回退 | 文件快照、逐行 Diff、Office 二进制检查点、对话级 Anchor、跨轮恢复与冲突检查 |
| 独立检查 | 主 Agent 明确选择相关命令与审查；允许带着未验证/失败状态交付 |
| 项目知识 | 一个工作区可有多个知识项目；按任务选择开关与知识项目，模型通过工具按需读取，不将整库硬塞进上下文；保留来源和修订历史 |
| 扩展 | Skill 文件夹、MCP JSON、Browser、Office 与原生工具统一进入 Capability 系统 |
| 多模型 API | Aporia Cloud、多个 OpenAI-compatible Provider、多个密钥、`/models` 自动发现与任务级模型选择 |
| 桌面后台 | 关闭窗口时可收至系统托盘继续任务；托盘恢复/退出、Windows 完成通知、任务运行时间显示 |
| 本地 OCR | 中英文引擎仍在，首次下载语言模型；输入栏、附件和侧栏入口暂时隐藏 |

完整边界见 [SECURITY.md](SECURITY.md)。

## 界面预览

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
    <td width="50%"><a href="docs/assets/dialogue.png"><img src="docs/assets/dialogue.png" width="100%" alt="AporiaX 1.0.0-preview 对话与 Witness 执行摘要" /></a></td>
    <td width="50%"><a href="docs/assets/route.png"><img src="docs/assets/route.png" width="100%" alt="AporiaX 1.0.0-preview 执行记录、Agent 激活次数与 Builder 并发" /></a></td>
  </tr>
  <tr>
    <td align="center"><strong>对话</strong><br><sub>任务回复、Witness 执行摘要与追问</sub></td>
    <td align="center"><strong>执行记录</strong><br><sub>最新在前 · Agent 激活次数与 Builder 并发</sub></td>
  </tr>
  <tr>
    <td width="50%"><a href="docs/assets/workspace.png"><img src="docs/assets/workspace.png" width="100%" alt="AporiaX 1.0.0-preview 工作区文件树、代码高亮与侧栏打开入口" /></a></td>
    <td width="50%"><a href="docs/assets/understanding.png"><img src="docs/assets/understanding.png" width="100%" alt="AporiaX 1.0.0-preview 项目知识切换、分类搜索与来源" /></a></td>
  </tr>
  <tr>
    <td align="center"><strong>工作区</strong><br><sub>文件树、代码高亮与侧栏预览</sub></td>
    <td align="center"><strong>项目知识</strong><br><sub>按项目分类保存，任务按需读取</sub></td>
  </tr>
  <tr>
    <td width="50%"><a href="docs/assets/sidebar-documents.png"><img src="docs/assets/sidebar-documents.png" width="100%" alt="AporiaX 侧栏 Markdown 阅读、源码与编辑模式，和主对话同屏" /></a></td>
    <td width="50%"><a href="docs/assets/sidebar-browser.png"><img src="docs/assets/sidebar-browser.png" width="100%" alt="AporiaX 侧栏内置浏览器，与主对话并排浏览网页" /></a></td>
  </tr>
  <tr>
    <td align="center"><strong>侧栏 · 文档阅读</strong><br><sub>Markdown 排版预览，阅读 / 源码 / 编辑切换</sub></td>
    <td align="center"><strong>侧栏 · 浏览器</strong><br><sub>网页与任务同屏，保留对话上下文</sub></td>
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

对话、执行记录、工作区、项目知识及两张侧栏截图已更新为 1.0.0-preview，可点击查看原图；欢迎页、关于和设置截图保留此前版本，当前界面以安装包为准。

## 1.0.0-preview

- **中断不再直接等于失败**：临时连接故障进入等待并退避重连；系统睡眠暂停新工作，唤醒后继续。手动暂停不会被自动解除，停止后不会被唤醒事件复活。
- **主/子 Agent 协作更明确**：独立上下文保留用户约束，结构化结果等待验收；暂停门控覆盖子任务与 Builder 队列，保留用户设置的并发上限。
- **执行记录更直观**：当前动作与历史分开、最新记录在前，支持详情弹窗、逐轮 Agent 激活统计和 Builder 并发/排队展示。
- **项目知识按需使用**：一个工作区支持多个知识项目，新建任务可选择启用；简化项目切换和设置，知识由模型按需读取。
- **更顺畅的首次使用与文件查看**：未登录的 Cloud 模型不可选择并提示添加自有 API；工作区复用侧栏文件预览，Anchor 默认收起。
- **保留 0.9.9 的长任务基础**：有来源的决策与诊断保存、有序工具调度、进程事件等待和证据验收；不强制无关测试，不伪称验证通过。

本地验证：**67/67** 个回归脚本、15 个自动暂停/恢复场景、浏览器状态展示及真实安装包内恢复/终端测试通过。尚无真实模型 A/B 提速或成本结论。

预览版已知问题：[发布提交的 GitHub 检查](https://github.com/CaptainLand/AporiaX/actions/runs/35625222832)中，Windows 知识项目、Curator 启动统计及执行记录 UI 检查未全部通过，仍待修复；上述本地结果不代表所有 CI 环境通过。

> 自动恢复要求应用进程仍存活；断电、退出或崩溃后仍需手动恢复。保留的是应用已接收且可保存的任务状态，不包括模型尚未返回的内部计算。未知结果的命令/上传等不会盲目重放，重连也可能重复计费。真实硬件断网、睡眠/唤醒仍待进一步实测。

[完整 1.0.0-preview 说明](docs/RELEASE_NOTES_v1.0.0-preview.md) · [0.9.9 说明](docs/RELEASE_NOTES_v0.9.9.md) · [更新历史](CHANGELOG.md)

## 下载

当前公开版本为 **v1.0.0-preview.5**。本版作为普通 GitHub Release 设为 **Latest**，进入默认更新通道；preview 名称和已知问题保留，不表示已完成 1.0.0 正式版验收。[打开 Latest 下载页](https://github.com/CaptainLand/AporiaX/releases/latest)。

旧版可在「设置 → 关于 → 检查更新」手动刷新。安装版可在应用内下载并重启安装；便携版检测到更新后打开下载页，下载新便携版替换。每次启动都会检查，运行期间每 12 小时再检查一次。

| Windows x64 | 当前公开包 |
| --- | --- |
| [查看 Releases](https://github.com/CaptainLand/AporiaX/releases) | 历史版本与发行说明 |
| [Preview 5 安装版](https://github.com/CaptainLand/AporiaX/releases/download/v1.0.0-preview.5/AporiaX-Setup-1.0.0-preview.5-x64.exe) | 推荐，可在应用内更新 |
| [Preview 5 便携版](https://github.com/CaptainLand/AporiaX/releases/download/v1.0.0-preview.5/AporiaX-Portable-1.0.0-preview.5-x64.exe) | 无需安装，更新时手动换包 |
| [SHA-256 校验值](https://github.com/CaptainLand/AporiaX/releases/download/v1.0.0-preview.5/SHA256SUMS-1.0.0-preview.5.txt) | 下载后核对 |

第一次使用：

1. 新建任务并选择本地工作目录。
2. 在模型选择中添加自己的 API / 本地 Provider，或登录 Aporia Account 使用 Aporia Cloud；未登录时 Cloud 模型置灰。
3. 按需选择本任务的项目知识，描述目标，在执行记录与工作区查看动作、文件修改和产物。

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
npm run test:suspension # 自动暂停与恢复专项
```

## 子 Agent 与项目约定

只读探索、审查、验证可以交给独立子 Agent。可写的 Git 任务可委派 Builder：并发 **0 / 1 / 2 / 3 / 4 / 6，默认 2**，在独立 worktree 里按范围写入，冲突检查通过后由主 Agent 合入。

Builder 只在授权范围内通过文件工具修改，不自行运行 shell 或发布；Main / Verify 根据任务需要验证，主 Agent 对返回结果进行验收。

工作区识别 `AGENTS.md`、`APORIAX.md`、`DEEPAGENT.md` 以及 `.aporiax/rules/*.md`。项目知识可分项目保存命令、架构约定和明确偏好；任务可关闭知识或按需读取，不强制注入整库，并拒绝写入凭据。

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

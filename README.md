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

AporiaX 是一个 local-first 桌面 Agent，把模糊需求转化为可观察、可验证、可回退的行动路径。它可以直接操作授权工作区、编辑代码、生成真实 Office 文件，并把每一步修改、验证依据和最终产物留在界面中，而不是只给出一段聊天回复。

> [!IMPORTANT]
> AporiaX 当前源码与 Windows 发行版本为 **`v0.9.8`**，仍处于 Preview 阶段。
> 0.9.8 加固任务历史、文件写入、Builder 恢复与执行边界，并暂时隐藏输入栏 OCR 入口；同时带上 0.9.7 的 OCR 引擎、Git 冲突与 Builder 并发。
> Aporia Account、Aporia Cloud、BYOK 与本地模型路径继续保持相互独立。

- **Route**：展示每一次任务实际发生的步骤，而不是隐藏在聊天文字之后。
- **Evidence**：保留工具调用、文件修改、验证结果和失败原因。
- **Anchor**：把可恢复检查点带到每一轮对话旁，支持预览 Diff、冲突检查和安全回退。

<table>
  <tr>
    <td width="50%"><img src="docs/assets/welcome.png" alt="AporiaX 浅色 Gem Smoke 欢迎页" /></td>
    <td width="50%"><img src="docs/assets/about.png" alt="AporiaX 设置 · 关于" /></td>
  </tr>
  <tr>
    <td align="center"><strong>从一个疑问开始</strong><br><sub>浅色 Gem Smoke 开屏与中英双语入口</sub></td>
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
  <tr>
    <td width="50%"><img src="docs/assets/settings-general.png" alt="AporiaX 通用设置" /></td>
    <td width="50%"><img src="docs/assets/settings-extensions.png" alt="AporiaX 扩展库" /></td>
  </tr>
  <tr>
    <td align="center"><strong>通用设置</strong><br><sub>语言、外观、模型与本地执行边界</sub></td>
    <td align="center"><strong>扩展</strong><br><sub>安装可审查的方法，而不是新权限</sub></td>
  </tr>
</table>

## 0.9.8 更新：历史与写入可靠性，OCR 入口暂隐

- **任务历史**：部分迁移可重试并保留原件；损坏任务不挡住健康历史；删除需显式确认并归档。
- **可恢复写入**：普通写文件、补丁和 Office 写入与 Builder 合并共用备份与失败可查提交。
- **Builder / Safe**：显式编排走委派 Builder 的快照与合并；Kernel 默认并发 6；Safe 在同一任务的成功命令之间保留私有依赖副本。
- **OCR**：引擎改为可终止子进程，并补上混合页/强制识别；输入栏、附件和侧栏的 OCR 按钮先隐藏。
- **IPC / MCP**：特权通道校验主窗口与应用来源；超时和取消传到 MCP，不把远端副作用说成已撤销。

[查看完整 0.9.8 更新记录](docs/RELEASE_NOTES_v0.9.8.md)

## 0.9.7 更新：本地 OCR、Git 冲突与 Builder

- **本地 OCR**：从输入栏、图片/PDF 附件或侧栏预览识别中英文图片与扫描 PDF；首次下载约 4.7 MB 资源后在本地运行，不上传文档。
- **Git 冲突与 PR**：侧栏对比并编辑普通 merge 冲突，确认后再暂存；只读查看当前分支的 GitHub PR 与检查状态。
- **Builder**：并发可选 0 / 1 / 2 / 3 / 4 / 6，默认 2；超出的工作排队。修复非 UTF-8 检查点恢复。
- **0.9.6**：修复交付链接截断，Safe 使用独立依赖副本，异常后保留可打开的恢复目录。

[查看完整 0.9.7 更新记录](docs/RELEASE_NOTES_v0.9.7.md)

## 0.9.5 更新：可靠的工具消息与任务恢复

- **工具消息**：修复读取外部目录后缺失 `content` 导致模型请求失败的问题；请求发送前校验，旧检查点缺失回执按“结果未知”恢复。
- **任务重试**：后台状态未知时不再误停新任务；Witness 跟随最新一轮，历史失败折叠，残留运行标记不会锁住重试。
- **保留成果**：失败时提供已保存文件的打开链接，错误详情可展开；不将未完成或未验证的任务标为成功。
- **扩展生态**：在线搜索 MCP / Skill，查看来源、许可和依赖，再安装/连接并检查可用性；提供带来源的 Word、主题和调试资源。

[查看完整 0.9.5 更新记录](docs/RELEASE_NOTES_v0.9.5.md)

## 0.9.0 更新：更实用的同屏工作台

- **侧边聊天**：从空侧栏或「＋」打开，查询当前任务的公开进度与记录，或独立聊天；状态与引用使用应用内弹窗，转交主 Agent 前可编辑确认。
- **文档预览**：Markdown 支持标题、表格、代码高亮与安全链接；Word 支持样式化页面、缩放与适应宽度，仍为近似排版。
- **Git 第六入口**：查看改动与 Diff、暂存、提交、分支、仓库初始化/克隆、远程配置和 GitHub 浏览器登录；创建远程仓库与推送分开确认。
- **终端**：主题跟随、搜索、复制粘贴、字号与重命名；切换标签保留画面，进程退出完整读取末尾输出。修复打字回显延迟，聚焦光标持续可见。
- **桌面细节**：修复工作区内绝对文件路径展示；安装包任务栏图标统一为更醒目的现有大 AX。

[查看完整 0.9.0 中英文更新记录](docs/releases/v0.9.0.md)

## 0.8.5 更新：回退后告知模型

- Anchor 仍然只回退工作区文件，不删对话。
- 回退成功后写入一条运行时说明：以当前文件为准，不要继续被回退的实现。这条说明不是新的用户任务。

[查看完整 0.8.5 中英文更新记录](docs/releases/v0.8.5.md)

## 0.8.4 更新：Browser 首屏、Understanding / MCP / Skill

- 打开网页链接时原生 Browser 会立刻画出页面，不必再拖分割条。
- 欢迎页结束后检查 GitHub 是否有新版本。安装版可在应用内下载并重启安装；便携版打开下载页。
- Understanding 默认只查看；注入模型和自动整理要在设置里打开。过期或文件已变的知识不进上下文。
- MCP 大结果分页读取；单个服务器失败不再打掉整次发现。明确选中的 Skill 不会被自动匹配上限丢掉。
- 本包同时带上 0.8.1–0.8.3：终端中断与代码高亮、长任务 Builder、附件拖到工作台预览、Builder 数量可选。

[查看完整 0.8.4 中英文更新记录](docs/releases/v0.8.4.md)

## 0.8.0 更新：同屏工作台

- 右侧栏可在同一屏幕打开 Route、文件、Browser、用户终端和 Agent 进程日志。
- 打开侧栏内容由 Agent 调用 `present_to_user` 决定；写文件或跑命令不会自动弹出，回答里的 Markdown 链接也不会打开侧栏。
- 退出再开会清掉已经不存在的 Browser / 终端会话，避免对失效 id 闪退。
- GPU 连续崩溃不再把窗口杀掉；欢迎页着色器降帧并错开加载。审批角落通知改为 10 秒。

[查看完整 0.8.0 中英文更新记录](docs/releases/v0.8.0.md)

## 0.7.5 更新：浅色 Gem Smoke 开屏

- 欢迎页改为原版 AX 上的 Gem Smoke，浅色 Mesh 背景，Liquid Metal 进入按钮。
- 点空白可循环多种 logo 着色效果；减少动态效果时只用静态 PNG。
- 需要确认时角落弹出通知，可确认或拒绝；点了立刻关掉，5 秒未点也会消失。
- 切换时不再挖空闪白；本包每次启动都先显示欢迎页。
- 0.7.4 的分任务落盘、原生视觉默认和夜间托盘图标保持不变。

[查看完整 0.7.5 中英文更新记录](docs/releases/v0.7.5.md)

## 0.7.4 更新：分任务落盘与安静桌面

- 每个任务单独 JSON，附件按哈希落盘；单个任务超过 200 MB 才跳过，其余照常保存。
- 自定义模型默认原生视觉，看图被拒绝后自动改为仅文本。
- 任务栏 / 托盘 / 收纳篮使用夜间 AX；软件内 logo 仍随主题。
- 去掉 Witness 停滞横幅和侧栏登录错误码；下次启动回到上次任务、页签和滚动位置。

[查看完整 0.7.4 中英文更新记录](docs/releases/v0.7.4.md)

## 0.7.3 更新：Agent 主导检查与诚实交付

- 不再因文件数、计划完成或根目录测试脚本自动跑测试、Review 或强制自检。
- 主 Agent 明确选择的命令才会执行；`verification:true` 才记为验证证据，跳过不会把失败改成通过。
- 未验证、失败、环境不可用或过期时仍可交付已有文件，界面不再把「无需审查」显示成测试通过。
- 原生视觉按图片块估算预算，超预算会保留已完成工作；含图片的用量不污染文本校准。
- Kernel 与编排共用写范围锁，重叠 scope 不能同时打开，冲突后不会退回父工作区。

[查看完整 0.7.3 中英文更新记录](docs/releases/v0.7.3.md)

## 0.7.2 更新：更可靠、更顺畅的桌面工作流

- SQLite 检查点与操作回执保存任务状态；不确定的副作用在恢复时重新确认。
- 验证结果绑定文件版本，分段读取按内容哈希和覆盖范围核验，避免旧证据误判。
- 插话可取消主模型当前生成并重新请求；已开始的工具先完成，尚未开始的操作跳过。
- 插话前后回复分段展示，保留原输出与 Witness / Anchor 关联。
- 文件链接支持打开、另存为、文件夹定位、其他应用 / IDE 打开及复制路径；可执行文件需确认。
- 合入既有 Desktop 远程任务同步与逐文件确认的只读传输入口；实际可用性取决于 Cloud 与网络配置。

[查看完整 0.7.2 中英文更新记录](docs/releases/v0.7.2.md)

## 0.7.1 更新：更快、更克制的 Harness

- Explore、Verify 与 Understanding Curator 使用按角色分配的低计算强度，Review 仍可继承主任务的推理深度。
- 强制自检改为按风险升级；认证、安全、运行时、依赖与部署等高影响路径继续严格检查。
- Understanding 整理延后到主结果完成后，并跳过不值得沉淀的低价值轮次。
- 流式输出一旦开始便不再重放请求，避免重复或损坏回复。
- 桌面端 Aporia Account 登录默认打开当前腾讯云 Web 授权页，不再跳转旧 GitHub Pages。

[查看完整 0.7.1 中英文更新记录](docs/releases/v0.7.1.md)

## 0.7.0 基础架构：Aporia Account、Cloud 模型与原生视觉

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
| Builder 编排 | 并发可选 0 / 1 / 2 / 3 / 4 / 6，默认 2；Task Graph、Scope Lease、独立 Git worktree 与冲突安全合并 |
| Agent 协作 | Shared Contract、Plan Approval、结构化 handoff 与有界 mailbox；Main 保持最终集成权 |
| 可观察执行 | Witness 在 Dialogue 实时记录主/子 Agent、当前动作、耗时、失败与自检阶段；Route 保留完整路径 |
| 审核与回退 | 文件快照、逐行 Diff、Office 二进制检查点、对话级 Anchor、跨轮恢复与原子冲突检查 |
| 独立检查 | 主 Agent 明确选择相关命令与审查；Harness 记录真实证据并允许带着未验证/失败状态交付 |
| 项目理解 | Understanding 持续沉淀架构、约定、命令、偏好和调试经验，供项目内任务共享 |
| 扩展 | Skill 文件夹、MCP JSON、Browser、Office 与原生工具统一进入 Capability 系统 |
| 多模型 API | Aporia Cloud、多个 OpenAI-compatible Provider、多个密钥、`/models` 自动发现与任务级模型选择 |
| 桌面后台 | 关闭窗口时可收至系统托盘继续任务；托盘恢复/退出、Windows 完成通知、任务运行时间显示 |

扫描版 PDF 与图片可通过内置本地 OCR 识别（中英文，首次下载语言模型）。Aporia Cloud 图片附件仍可走 Cloud Vision；BYOK / 本地模型的图片能力取决于用户自己的视觉模型与配置。

## 下载

`main` 当前是 **v0.9.8 源码状态**，Windows x64 安装版与便携版均从 GitHub Releases 提供。

| Windows x64 | 当前公开包 |
| --- | --- |
| [查看 Releases](https://github.com/CaptainLand/AporiaX/releases) | 所有历史版本与发行说明 |
| [0.9.8 安装版](https://github.com/CaptainLand/AporiaX/releases/download/v0.9.8/AporiaX-Setup-0.9.8-x64.exe) | 推荐的 Windows x64 安装包 |
| [0.9.8 便携版](https://github.com/CaptainLand/AporiaX/releases/download/v0.9.8/AporiaX-Portable-0.9.8-x64.exe) | 无需安装的 Windows x64 便携包 |

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

# 0.7.1 核心验证
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

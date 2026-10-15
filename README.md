<p align="center"><img src="build/icon.png" width="88" alt="AporiaX" /></p>
<h1 align="center">AporiaX</h1>
<p align="center"><strong>简体中文</strong> · <a href="README_EN.md">English</a></p>
<p align="center"><em>Every problem begins with an aporia.</em></p>

<p align="center">
  <a href="https://aporiax.cloud"><strong>官网 · aporiax.cloud</strong></a>　·　
  <a href="https://github.com/CaptainLand/AporiaX/releases/tag/v1.0.0">下载 1.0.0 正式版</a>　·　
  <a href="https://aporiax.cloud/guide/">使用教程</a>
</p>
<p align="center">
  <a href="https://github.com/CaptainLand/AporiaX/releases/tag/v1.0.0"><img alt="Release 1.0.0" src="https://img.shields.io/badge/release-1.0.0-2689f5"></a>
  <a href="https://github.com/CaptainLand/AporiaX/releases"><img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-24272c?logo=windows"></a>
  <a href="LICENSE"><img alt="Source Available" src="https://img.shields.io/badge/License-Source_Available-6b7280"></a>
</p>

AporiaX 是 Windows 上的本地优先桌面 Agent：在你授权的工作区里编写代码、运行命令、生成 Word / Excel / PowerPoint，把主对话、文件、终端、浏览器、Git 和专业 Agent 放进同一个工作台。你可以查看行动记录、审查文件改动，并通过 Anchor 回退。

## 1.0.0 正式版

- **完整工作台**：统一的白天／暗夜界面，扁平化对话与 Witness 摘要；侧栏查看文档、代码、终端、Git，也可单独聊进度和想法。
- **专业 Agent 团队**：角色可配置模型、思考强度、预算与受控能力；主 Agent 可提出新增、修改、删除自定义角色，每次都需要用户确认。内置角色不能删除。
- **Agent 工位与团队消息**：可旋转、缩放的 2.5D 办公室、六位角色形象、私聊与工作群。闲聊不直接执行任务，实际工作要求需确认后交给主 Agent。
- **账户与个性化**：Cloud 请求历史、Token 统计、每日用量日历与团队头像。实验性自定义主题支持基础配色和背景图片，也可让 Agent 提交候选后自行应用。
- **统一权限入口**：权限与审批集中在设置；工作区外文件访问默认关闭。专业角色、Skills 和 MCP 不能突破父任务的授权边界。
- **安装与更新修复**：旧客户端可运行新安装器更新原目录。正式版交互安装加入“整理安装副本”，确认后备份可识别的旧程序；选择父目录时自动创建 `AporiaX` 文件夹。

[正式版说明](docs/RELEASE_NOTES_v1.0.0.md) · [安装与副本整理](docs/INSTALLATION_ORGANIZER.zh-CN.md) · [更新历史](CHANGELOG.md)

## 下载与开始使用

| Windows x64 | 下载 |
| --- | --- |
| 安装版（推荐） | [AporiaX-Setup-1.0.0-x64.exe](https://github.com/CaptainLand/AporiaX/releases/download/v1.0.0/AporiaX-Setup-1.0.0-x64.exe) |
| 便携版 | [AporiaX-Portable-1.0.0-x64.exe](https://github.com/CaptainLand/AporiaX/releases/download/v1.0.0/AporiaX-Portable-1.0.0-x64.exe) |
| 校验文件 | [SHA256SUMS-1.0.0.txt](https://github.com/CaptainLand/AporiaX/releases/download/v1.0.0/SHA256SUMS-1.0.0.txt) |

1. 安装并选择工作区。关闭窗口可能只是缩到托盘；更新或整理旧副本前，请从托盘退出旧程序。
2. 登录 Aporia Account 使用 Aporia Cloud，或在“模型与 API”添加自己的服务／本地模型。
3. 描述目标，在执行记录、工作区和侧栏中检查过程与产物。项目知识按任务选择开启，不会默认塞入整个知识库。

安装版可在“设置 → 关于”检查更新，下载后重启安装；增量下载取决于旧包缓存和下载服务，失败会回退完整下载。便携版需手动换包。**Windows 安装包目前未做可信代码签名**，可先核对校验文件。

“整理安装副本”只处理本次确认且可安全识别的程序文件，移入可恢复备份；不清理对话、凭据、工作区或混放文档。它不全盘扫描，也不保证发现所有手动复制的文件夹；静默安装与便携版不会自动整理。

## 界面预览

<table>
  <tr>
    <td width="50%"><a href="docs/assets/dialogue.png"><img src="docs/assets/dialogue.png" alt="主对话与扁平化 Witness 摘要" /></a></td>
    <td width="50%"><a href="docs/assets/agent-office.png"><img src="docs/assets/agent-office.png" alt="六位 Agent 的 2.5D 工位" /></a></td>
  </tr>
  <tr><td align="center">对话与行动摘要</td><td align="center">Agent 工位</td></tr>
  <tr>
    <td><a href="docs/assets/dialogue-dark.png"><img src="docs/assets/dialogue-dark.png" alt="暗夜模式主对话" /></a></td>
    <td><a href="docs/assets/agent-office-dark.png"><img src="docs/assets/agent-office-dark.png" alt="暗夜模式 Agent 工位" /></a></td>
  </tr>
  <tr><td align="center">暗夜工作台</td><td align="center">暗夜工位</td></tr>
  <tr>
    <td><a href="docs/assets/route.png"><img src="docs/assets/route.png" alt="执行记录" /></a></td>
    <td><a href="docs/assets/workspace.png"><img src="docs/assets/workspace.png" alt="工作区与文件预览" /></a></td>
  </tr>
  <tr><td align="center">执行记录</td><td align="center">工作区</td></tr>
  <tr>
    <td><a href="docs/assets/team-messages.png"><img src="docs/assets/team-messages.png" alt="Agent 工作群" /></a></td>
    <td><a href="docs/assets/account-usage.png"><img src="docs/assets/account-usage.png" alt="账户每日用量日历" /></a></td>
  </tr>
  <tr><td align="center">团队消息</td><td align="center">账户与用量</td></tr>
  <tr>
    <td><a href="docs/assets/understanding.png"><img src="docs/assets/understanding.png" alt="项目知识" /></a></td>
    <td><a href="docs/assets/sidebar-documents.png"><img src="docs/assets/sidebar-documents.png" alt="侧栏文档阅读" /></a></td>
  </tr>
  <tr><td align="center">项目知识</td><td align="center">侧栏文档</td></tr>
  <tr>
    <td><img src="docs/assets/settings-general.png" alt="通用设置" /></td>
    <td><img src="docs/assets/settings-extensions.png" alt="Skills 与 MCP" /></td>
  </tr>
  <tr><td align="center">统一设置</td><td align="center">扩展与能力</td></tr>
</table>

截图更新于 2026-10-15，使用虚构账户、项目、对话和用量记录，不展示真实工作区。浏览器侧栏演示截图仅包含界面框架。

## 核心能力与边界

| 能力 | 说明 |
| --- | --- |
| 文件与代码 | 分页读取、ripgrep 搜索、Unified Patch、代码预览与文档编辑；识别 `AGENTS.md`、`APORIAX.md` 等项目约定 |
| 专业角色 | 阿珀 AporiaX 协调；探奇 Scout 探索，察微 Sentry 审查，验准 Checko 验证，搭匠 Forge 构建，知序 Index 整理知识 |
| 可写子任务 | Builder 使用受控写入范围和独立工作区；冲突检查后由主 Agent 接收改动，不自行运行 shell 或发布 |
| 验证与回退 | 保留命令结果、文件 Diff、行动记录与 Anchor；正常回复不等于所有目标都已验证，仍需阅读结果与未完成原因 |
| 项目知识 | 每个工作区可有多个知识项目，任务独立选择；工具按需读取，保留来源与修订 |
| Skills / MCP / LSP | 扩展工作方法和工具能力；支持诊断、定义、引用等语言服务，不绕过任务权限 |
| 文档与 Git | 生成真实 Office 文件；Git 状态、Diff、提交与远端操作，侧栏冲突编辑和只读 PR 信息 |
| 模型 | Aporia Cloud、自有 API 与本地模型独立选择；思考强度随模型能力切换，不会因额度耗尽偷偷切换供应商 |
| 执行与审批 | Direct / Safe / Isolated 和三档审批；Safe 临时工作区并非 OS 沙箱，Isolated 需要可用 Docker，不静默降级 |
| 暂停与恢复 | 临时网络问题可等待恢复；未知结果的副作用不盲目重放，退出／断电不保证自动续跑，恢复可能重复计费 |

### 隐私

项目、文件和对话默认保存在本机。当前版本已移除手机伴侣的后台项目同步、远程文件浏览／上传和远程任务控制；登录账户不会自动上传整个工作区。

**本地优先不等于云模型离线运行**：完成任务所需的提示词、对话片段、文件内容或附件会发送到所选模型服务。MCP、联网工具和授权的 Git 推送也可能外发数据。API Key 由主进程通过系统加密存储管理，不回传给渲染进程。完整边界见 [SECURITY.md](SECURITY.md)。

### 外部 Harness

在顶栏“外部连接”中显式启用本地 HTTP API、MCP stdio 或 CLI 接入。为调用方选择已有工作区、模型和限额，创建独立连接并可随时撤销；工具审批由桌面用户处理。安装版附带桥接运行时，无需额外安装 Node。

“设置 → 权限与审批 → 工作区外文件访问”默认关闭；开启需确认，仍保留只读任务、敏感配置和独立工具授权边界，不授予管理员权限。

[本地接入指南](docs/LOCAL_CONTROL.md) · [Agent 工位](docs/agent-office.md) · [团队消息](docs/team-messages.md)

## 从源码运行

需要 Node.js 22.12.0 或更高版本；Docker 仅在 Isolated 模式需要。

```powershell
git clone https://github.com/CaptainLand/AporiaX.git
cd AporiaX
npm install
npm run dev
```

```powershell
npm run build             # 构建界面与桥接程序
npm run dist:win          # Windows 安装版与便携版
npm run test:audit-suite  # 本地回归检查
```

不要把真实密钥、用户配置、对话或日志提交到仓库。贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[AporiaX 源码可用许可 1.0](LICENSE) © 2026 CaptainLand 及相应权利人。

允许个人／企业内部使用、修改、免费 Fork，以及将独立工作成果用于商业项目；未经书面授权，不允许出售原版或换皮版本、收费解锁或经营收费的软件功能访问服务。修改版须标明非官方。这不是 OSI 开源许可。

历史 MIT 权利与第三方授权不被追溯撤销：RC5.2 及更早已按 MIT 发布的副本保持原授权。详见 [授权通知](licenses/NOTICE.txt) 和 [历史 MIT 原文](licenses/LEGACY-MIT.txt)。商业授权可通过 [GitHub Issues](https://github.com/CaptainLand/AporiaX/issues) 联系维护者。

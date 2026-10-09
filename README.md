<p align="center"><img src="build/icon.png" width="88" alt="AporiaX" /></p>
<h1 align="center">AporiaX</h1>
<p align="center"><em>Every problem begins with an aporia.</em></p>

<p align="center">
  <strong><a href="https://aporiax.cloud">官网 · aporiax.cloud</a></strong> · <a href="https://github.com/CaptainLand/AporiaX/releases/tag/v1.0.0-rc.5.1">下载 RC5.1</a> · <a href="https://aporiax.cloud/guide/">使用教程</a> · <a href="https://aporiax.cloud/account">账户中心</a>
</p>
<p align="center"><a href="README.md">简体中文</a> · <a href="README_EN.md">English</a></p>
<p align="center">
  <a href="https://github.com/CaptainLand/AporiaX/releases/tag/v1.0.0-rc.5.1"><img alt="1.0.0-rc.5.1" src="https://img.shields.io/badge/release-1.0.0--rc.5.1-59a9cf"></a>
  <a href="https://github.com/CaptainLand/AporiaX/tree/v1.0.0-rc.5.1"><img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-202830?logo=windows"></a>
  <a href="LICENSE"><img alt="AporiaX Source Available License" src="https://img.shields.io/badge/License-Source_Available-59a9cf.svg"></a>
</p>

AporiaX 是 Windows 上的本地优先桌面 Agent。在授权范围内改代码、运行命令、生成 Word / PPT / Excel；对话、文件、浏览器、终端和 Git 放在同一窗口，保留执行记录、证据和回退入口。

> [!IMPORTANT]
> 当前版本为 **1.0.0-rc.5.1**（候选版），不是 1.0.0 正式版。[发行说明](https://github.com/CaptainLand/AporiaX/releases/tag/v1.0.0-rc.5.1) · [对应源码](https://github.com/CaptainLand/AporiaX/tree/v1.0.0-rc.5.1)。
> 桌面登录、账户中心、Cloud 网关与国内下载统一接入 **[aporiax.cloud](https://aporiax.cloud)**。旧地址凭据不会自动转发；升级后可能需要重新登录。
> RC5.1 已进入默认更新渠道。Windows 安装包仍未具备可信代码签名，可能出现系统安全提示。

## RC5 更新重点

- **专业角色设置**：配置 Explore / Review / Verify / Curator / Builder 或自定义角色的职责、模型、思考强度与预算；Builder 数量移入设置。
- **主 Agent 调度**：主 Agent 可以发现并委派已配置的角色；独立工作并行，有依赖则等待，系统执行并发与累计预算约束。
- **受控能力组合**：按角色选择 Skills、MCP、项目知识和验证工具，不突破父任务权限。专业 Agent 面板显示状态、结果与用量，支持追加要求和停止；价格未知时不虚构费用。
- **新域名接入**：桌面授权、账户管理、Cloud 请求和国内下载统一使用官网。
- **项目知识入口**：当前任务未开启时先显示启用入口；同一工作区支持多个知识项目，仍按任务绑定、通过工具按需读取。
- **延续 RC4 修复**：统一日/夜布局与主/侧聊天模型选择，保留滚动上下文摘要、调用恢复、Skills / MCP 和本机外部连接能力。

验证：本地 **103/103** 核心回归、**30/30** 桌面检查通过；[RC5 Windows / Linux CI](https://github.com/CaptainLand/AporiaX/actions/runs/37784953275) **6/6** 任务通过。模拟模型测试不代表真实供应商兼容性或提速、成本保证。

## 下载

[官网](https://aporiax.cloud) · [GitHub Latest](https://github.com/CaptainLand/AporiaX/releases/latest) · [历史版本](https://github.com/CaptainLand/AporiaX/releases)

| Windows x64 · RC5.1 | 国内下载 | GitHub |
| --- | --- | --- |
| 安装版（推荐） | [官网下载](https://aporiax.cloud/downloads/AporiaX-Setup-1.0.0-rc.5.1-x64.exe) | [GitHub 下载](https://github.com/CaptainLand/AporiaX/releases/download/v1.0.0-rc.5.1/AporiaX-Setup-1.0.0-rc.5.1-x64.exe) |
| 便携版 | [官网下载](https://aporiax.cloud/downloads/AporiaX-Portable-1.0.0-rc.5.1-x64.exe) | [GitHub 下载](https://github.com/CaptainLand/AporiaX/releases/download/v1.0.0-rc.5.1/AporiaX-Portable-1.0.0-rc.5.1-x64.exe) |
| SHA-256 校验值 | [官网校验文件](https://aporiax.cloud/downloads/SHA256SUMS-1.0.0-rc.5.1.txt) | [GitHub 校验文件](https://github.com/CaptainLand/AporiaX/releases/download/v1.0.0-rc.5.1/SHA256SUMS-1.0.0-rc.5.1.txt) |

旧版可在「设置 → 关于 → 检查更新」手动刷新。安装版可在应用内下载并重启安装；便携版需下载新文件替换。RC5.1 被设为 Latest 供更新发现，不表示已完成正式版验收。

## 主要能力

| 能力 | 当前实现 |
| --- | --- |
| 代码与工作区 | 分页读取、ripgrep 搜索、文件树与编辑、多文件 Patch、Git 状态与 Diff |
| 同屏工作台 | 文件、浏览器、终端、Git 与侧边聊天；Agent 可以将产物呈现在侧栏 |
| Git / GitHub | 初始化、暂存/提交/分支、远端、拉取/推送、创建仓库、冲突编辑与只读 PR / CI 查看 |
| 专业角色 | 默认角色与自定义职责；模型、思考强度、预算和能力组合；主 Agent 发起调度 |
| Builder | 设置中调整并发 0–6，默认 2；任务级继承、独立 Git worktree、范围限制与冲突安全合并 |
| 长对话 | 同模型自动滚动摘要、本机原文回读和有界恢复；不是无限上下文，摘要计入正常用量 |
| 项目知识 | 默认按任务选择启用，一个工作区可建多个知识项目；按需读取，保留来源和修订历史 |
| 扩展 | Skills、MCP 与原生工具；角色能力受父任务权限、范围和审批约束 |
| 外部连接 | 受鉴权的本机 API / MCP，对接已创建的工作区；不是默认公开的远程服务 |
| 权限与执行 | Direct / Safe / Isolated；工作区外文件权限默认关闭，明确开启后仍保留敏感目录保护 |
| 文档与语言智能 | Word / PPT / Excel 生成与结构检查；LSP 诊断、定义、引用等 |
| Aporia Cloud | 托管模型、周额度、原生图片与服务端可用性检查；与自有 API / 本地模型独立 |
| Web 账户中心 | 额度、设备、安全和逐次请求记录；待核对用量不再预扣全站日额度，核对及真实结算仍保留 |
| 审核与恢复 | 执行记录、文件 Diff、快照与 Anchor；暂停/恢复不盲目重放未知副作用 |
| 桌面后台 | 系统托盘、完成通知与运行时间；应用退出后的恢复不等于始终在线 |

## 开始使用

1. 新建任务并选择本地工作区。
2. 添加自己的 API / 本地 Provider，或登录 Aporia Account 使用 Cloud。
3. 按需开启项目知识；在「设置 → 专业角色」配置协作者，再描述目标。
4. 在执行记录和工作区查看进展、修改与产物。

[完整使用教程](https://aporiax.cloud/guide/) · [安全边界](SECURITY.md)

## 界面预览

以下是已公开的历史截图，部分来自 Preview 阶段，并非全部为 RC5 界面；当前安装包为准。

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

## 从源码运行

需要 **Node.js 22.12.0 或更高版本**。以下命令检出与安装包对应的 RC5.1 标签，避免把开发中的 main 当成发布源码。

```powershell
git clone --branch v1.0.0-rc.5.1 --single-branch https://github.com/CaptainLand/AporiaX.git
cd AporiaX
npm install
npm run dev
```

```powershell
npm run build
npm run dist:win
npm run test:audit-suite
```

Docker Desktop 仅 Isolated 模式需要；Direct 与 Safe 可不安装 Docker。API Key 由 Electron safeStorage 加密，不要将真实密钥放进源码、Issue 或日志。

## 执行边界

主 Agent 委派，运行时控制权限、预算、依赖与并发。Builder 在授权范围内通过文件工具写入，不自行运行 shell 或发布；Main / Verify 按任务需要检查，返回结果不等于验收通过。

工作区支持 `AGENTS.md`、`APORIAX.md`、`DEEPAGENT.md` 和 `.aporiax/rules/*.md`。项目根目录的 `.aporiax.json` 只能进一步收紧权限，不能把只读任务提升为可写。

自动续跑依赖应用进程仍存活；退出、崩溃、供应商不可用及真实硬件睡眠行为仍有边界。模型未返回的内部计算无法恢复，长上下文也不是无限记忆。Cloud 额度用尽不会静默切换到另一家供应商。

## 参与贡献与许可

[贡献指南](CONTRIBUTING.md) · [安全问题](SECURITY.md) · [源码可用许可](LICENSE) © 2026 CaptainLand 及相应权利人。

当前开发源码允许个人使用、企业内部使用、独立成果商用、修改和免费 Fork。未经书面授权，不允许出售原版或换皮版本、收费解锁，或对外提供收费的软件实质功能访问；修改版须标明非官方。商业授权可通过 [GitHub Issues](https://github.com/CaptainLand/AporiaX/issues) 联系维护者。

此许可不是 OSI 意义上的开源许可，不取消独立取得的历史 MIT 或第三方授权。已发布 RC5.2 及其他 MIT 副本保持原许可，此次仅同步源码许可声明，不修改版本号、不重发旧包。范围见 [licenses/NOTICE.txt](licenses/NOTICE.txt)，历史原文见 [licenses/LEGACY-MIT.txt](licenses/LEGACY-MIT.txt)。

<p align="center">
  <img src="build/icon.svg" width="88" alt="AporiaX" />
</p>

<h1 align="center">AporiaX</h1>

<p align="center">
  <strong>简体中文</strong> · <a href="README_EN.md">English</a>
</p>

<p align="center">
  <strong>从一个疑问开始。</strong><br>
  写代码、制作文档、演示文稿与表格。告诉 AporiaX，你想抵达哪里。
</p>

<p align="center">
  <em>Every problem begins with an aporia.</em>
</p>

<p align="center">
  <a href="https://github.com/CaptainLand/AporiaX/releases/tag/v0.3.0"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/CaptainLand/AporiaX?include_prereleases&color=59a9cf"></a>
  <a href="https://github.com/CaptainLand/AporiaX/releases/download/v0.3.0/AporiaX-Setup-0.3.0-x64.exe"><img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-202830?logo=windows"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-59a9cf.svg"></a>
</p>

AporiaX 是一个 local-first 桌面 Agent，把模糊需求转化为可观察、可验证、可回退的
行动路径。它可以直接操作授权工作区、编辑代码、生成真实 Office 文件，并把每一步修改、
验证依据和最终产物留在界面中，而不是只给出一段聊天回复。

> [!IMPORTANT]
> AporiaX `v0.3.0` 仍处于 Preview 阶段，当前提供 Windows x64 构建。
> `run_command` 会优先在 Docker OS 级容器沙箱中执行；
> Docker 或镜像不可用时会回退到本机执行，并强制逐条审批。本机模式可联网且不具备 OS 隔离。

## 为什么是 AporiaX

- **Route**：展示每一次任务实际发生的步骤，而不是隐藏在聊天文字之后。
- **Evidence**：保留工具调用、文件修改、验证结果和失败原因。
- **Anchor**：为文件修改建立检查点，支持逐行审核和安全回退。

## 现在可以做什么

| 能力 | 当前实现 |
| --- | --- |
| 代码与工作区 | 文件树、搜索、预览、编辑、`Ctrl+S`、精确 Patch、Git 状态与 Diff |
| 文档生产 | 生成真实 `.docx`、`.pptx`、`.xlsx`，并进行结构化复核 |
| 可观察执行 | Dialogue、Route、Workspace 三种视图；逐步展示工具调用与修改 |
| 审核与回退 | 文件快照、逐行 Diff、Office 二进制检查点、单文件或整轮撤销 |
| 强制自检 | 复读本轮修改，尝试测试或构建，发现问题后继续修复并报告剩余风险 |
| 多模型 API | 多个 OpenAI-compatible Provider、多个密钥、`/models` 自动发现与任务级模型选择 |
| 中英双语 | 开屏与设置页即时切换；界面和新回复跟随语言，历史消息与文件保持原样 |
| 附件与解析 | PDF、Office、Markdown、代码和图片附件；PDF 本地文本提取 |
| 权限与执行 | `allow` / `ask` / `deny` 策略；Docker 沙箱优先，本机强制审批降级 |

扫描版 PDF 当前会被识别为“需要 OCR”，但尚未内置 OCR 引擎。图片是否发送由每个
Provider 模型的视觉能力决定。

## 下载

| Windows x64 | 适合场景 |
| --- | --- |
| [下载安装版](https://github.com/CaptainLand/AporiaX/releases/download/v0.3.0/AporiaX-Setup-0.3.0-x64.exe) | 正常安装、桌面快捷方式与开始菜单 |
| [下载便携版](https://github.com/CaptainLand/AporiaX/releases/download/v0.3.0/AporiaX-Portable-0.3.0-x64.exe) | 不安装，直接运行和试用 |

首次启动后：

1. 新建任务并选择本地工作目录。
2. 添加一个 OpenAI-compatible API Provider 与模型。
3. 描述目标，查看 Route、文件修改、自检和最终产物。

Docker Desktop 是可选项。启用后，命令会进入默认断网的容器沙箱；未启用时，每条本机
命令都会单独请求批准，并明确显示“可联网、无 OS 隔离”。

## 从源码运行

需要 Node.js 20 或更高版本。若希望使用容器化 `run_command`，还需要启动 Docker Desktop；
应用内点击“准备 Docker 沙箱”会构建 `aporiax-sandbox:0.1` 本地镜像。
未启动 Docker 时仍可执行命令，但会逐条请求批准并直接使用当前用户权限在本机运行。

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
[docs/HARNESS_ROADMAP.md](docs/HARNESS_ROADMAP.md)。本版本说明见
[docs/RELEASE_NOTES_v0.3.0.md](docs/RELEASE_NOTES_v0.3.0.md)。

## 参与贡献

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按
[SECURITY.md](SECURITY.md) 私下报告，不要公开披露真实凭据或漏洞细节。

## License

[MIT](LICENSE) © 2026 CaptainLand

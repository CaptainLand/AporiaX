# AporiaX

> Every problem begins with an aporia.<br>
> 每个答案，都始于一个尚未解开的疑问。

AporiaX 是一个面向本地工作区的桌面 Agent。它不只返回答案，还把模糊需求转化为
可观察、可验证、可回退的行动路径。

[![License: MIT](https://img.shields.io/badge/License-MIT-59a9cf.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-39-202830.svg)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-202830.svg)](https://react.dev/)

> [!IMPORTANT]
> AporiaX 仍处于早期预览阶段。当前 `run_command` 有审批、路径、超时和输出限制，
> 但尚未运行在操作系统级沙箱中。请只在可信工作区中批准可信命令。

## 产品理念

- **Route**：展示每一次任务实际发生的步骤，而不是隐藏在聊天文字之后。
- **Evidence**：保留工具调用、文件修改、验证结果和失败原因。
- **Anchor**：为文件修改建立检查点，支持逐行审核和安全回退。

## 当前能力

- Dialogue、Route、Workspace 三种任务视图。
- 本地工作区文件树、搜索、代码预览和编辑，支持 `Ctrl+S` 保存。
- DeepSeek 流式回复、空闲超时、自动重试、手动停止和长上下文压缩。
- 可审计的 Agent 工具循环与 `allow` / `ask` / `deny` 权限策略。
- 文件读取、搜索、写入、精确替换、Git 状态与 Diff、审批式命令执行。
- 强制自检：重新读取本轮修改文件、尝试测试或构建，并报告剩余风险。
- 真实 Word、PowerPoint 和 Excel 文件生成及结构复核，无需 MCP 或本机 Office。
- PDF 本地文本解析、Workspace 只读预览以及 PDF/Office/Markdown/代码附件。
- 文件前后快照、逐行 Diff 审核、Office 二进制检查点和安全撤销。
- Electron 加密凭据存储、任务持久化、原生窗口控制和日间/夜间主题。
- `AGENTS.md`、`APORIAX.md` 和 `.aporiax.json` 项目级指令与权限配置。

扫描版 PDF 当前会被识别为“需要 OCR”，但尚未内置 OCR 引擎。当前 DeepSeek
模型配置按文本能力处理，不会发送 `image_url`。

## 快速开始

需要 Node.js 20 或更高版本。

```powershell
git clone https://github.com/CaptainLand/AporiaX.git
cd AporiaX
npm install
npm run dev
```

首次使用时在应用内安全保存 DeepSeek API Key。也可以通过环境变量提供：

```powershell
$env:DEEPSEEK_API_KEY="your-api-key"
npm start
```

不要把真实密钥写入源码、`.env`、Issue 或日志。

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
[docs/HARNESS_ROADMAP.md](docs/HARNESS_ROADMAP.md)。

## 参与贡献

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按
[SECURITY.md](SECURITY.md) 私下报告，不要公开披露真实凭据或漏洞细节。

## License

[MIT](LICENSE) © 2026 CaptainLand

# Security Policy

## Supported versions

AporiaX 目前处于早期预览阶段，仅维护最新的 `main` 分支和最新发布版本。

## Reporting a vulnerability

请不要为尚未修复的安全问题创建公开 Issue。请通过 GitHub Security Advisories 的
“Report a vulnerability”私下提交报告，并包含：

- 受影响的版本或提交；
- 可复现步骤；
- 影响范围；
- 建议的缓解方式（如有）。

## Current security boundaries

- DeepSeek API Key 通过 Electron `safeStorage` 保存在用户目录；也可通过
  `DEEPSEEK_API_KEY` 环境变量提供。
- 渲染进程未启用 Node.js，敏感操作通过受限 preload bridge 和 IPC 完成。
- 文件工具会校验工作区根目录和目标路径。
- `run_command` 需要审批，并带有工作目录、超时和输出限制。
- **当前版本尚未提供操作系统级命令沙箱。** 只应在可信工作区中批准可信命令。
- PDF 和附件在本地解析后以受限文本发送给模型；不要上传不希望提供给模型服务商的内容。

不要在 Issue、日志、截图或测试夹具中粘贴真实 API Key。

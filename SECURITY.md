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

- 多 Provider API Key 通过 Electron `safeStorage` 分别加密保存在用户目录；
  旧 DeepSeek 配置也可通过 `DEEPSEEK_API_KEY` 环境变量提供。
- 渲染进程未启用 Node.js，敏感操作通过受限 preload bridge 和 IPC 完成。
- 文件工具会校验工作区根目录和目标路径。
- `run_command` 需要审批，并且只在 Docker OS 级容器沙箱中执行。
- 沙箱默认断网，根文件系统只读，丢弃全部 Linux capabilities，启用
  `no-new-privileges`，限制 CPU、内存、进程数和打开文件数。
- 只有当前工作区以读写方式映射；标准 `.git` 目录会叠加为只读。容器不会挂载
  Docker socket，也不会继承宿主机 API Key 或其他环境变量。
- Docker 或沙箱镜像不可用时命令工具 fail-closed，不会回退到宿主机 Shell。
- 工作区本身仍是沙箱与宿主机之间的信任边界：获批命令可以修改或删除工作区文件，
  因此仍应审核命令和文件 Diff。
- PDF 和附件在本地解析后以受限文本发送给模型；不要上传不希望提供给模型服务商的内容。

不要在 Issue、日志、截图或测试夹具中粘贴真实 API Key。

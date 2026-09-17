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
- `run_command` 按任务的 Direct / Safe / Isolated 配置执行；Safe 是工作区副本保护，不是 OS 级隔离。
- 原生文件写入采用可恢复提交与原件备份；这不等于文件系统多文件事务。
- 特权 IPC 校验主窗口、主 Frame 与应用来源；不接受任意 file:// 页面。
- 沙箱默认断网，根文件系统只读，丢弃全部 Linux capabilities，启用
  `no-new-privileges`，限制 CPU、内存、进程数和打开文件数。
- 只有当前工作区以读写方式映射；标准 `.git` 目录会叠加为只读。容器不会挂载
  Docker socket，也不会继承宿主机 API Key 或其他环境变量。
- Isolated 模式需要可用 Docker；不可用时拒绝执行，不静默降级。
- Direct 和 Safe 都继承宿主进程/网络权限。Safe 为同一任务保留独立依赖副本，不与宿主
  `node_modules` 共享可写链接，成功命令之间可延续依赖，失败时保留恢复目录。
- 宿主执行过滤敏感环境变量，但不能阻止获准程序自行读取宿主文件或凭据；审批不是沙箱。
- Full Auto 是用户显式选择的宽授权模式，启发式命令分类不能识别所有间接副作用。
- OCR 在独立子进程解析图像/PDF，原生内存不受 V8 heap 参数的完整约束，尚非 OS 资源沙箱。
- MCP 停止/超时仅表示本地停止等待及发出取消；远程副作用可能已发生，必须保留不确定结果。
- 工作区本身仍是沙箱与宿主机之间的信任边界：获批命令可以修改或删除工作区文件，
  因此仍应审核命令和文件 Diff。
- PDF 和附件在本地解析后以受限文本发送给模型；不要上传不希望提供给模型服务商的内容。

不要在 Issue、日志、截图或测试夹具中粘贴真实 API Key。

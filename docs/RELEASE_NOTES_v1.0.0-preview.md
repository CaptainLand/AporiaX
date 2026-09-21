# AporiaX 1.0.0-preview

Windows x64 预览版，版本标签 `v1.0.0-preview`，不是 1.0.0 正式版。以 GitHub Pre-release 发布，不替换稳定版 Latest。

## 本版重点

- 临时断网：任务进入等待并按 15/30/60 秒退避恢复。系统明确离线时不继续请求模型；不向第三方网站发送健康探测。
- 系统睡眠：暂停新请求、工具操作和子 Agent 启动；唤醒后依据网络状态继续。锁屏或仅关闭显示器不触发任务停止。
- 暂停原因可叠加：网络/睡眠恢复不会解除用户暂停；停止后不会被在线或唤醒事件重新启动。
- 主/子 Agent 共用暂停门控；Builder 队列保留，并发数量仍遵循用户配置。
- 保留已经收到的上下文、待处理指导、工具收据与子 Agent 状态。流式中断文本单独保留为未完成记录；不完整工具调用不执行。
- 恢复只重新请求未完成的模型响应，不重跑已完成的文件修改或命令；结果未知的外部操作仍需核对。
- 命令 watchdog 扣除暂停时间，Witness 在等待期间不误报模型停滞；执行记录显示具体等待原因。

还包含当前工作区此前完成的项目知识界面、模型配置引导、执行记录和多 Agent 协作改进。

## 边界

- 自动恢复以 AporiaX 进程仍存活为前提。断电、进程崩溃或系统重启后仍通过原有手动恢复入口接续。
- “保留记忆”指已收到并可保存的任务状态，不包括模型服务端未返回的内部计算；突然断电前未落盘的字节无法保证保留。
- 已开始的命令、浏览器和 MCP 操作按真实结果处理，不承诺恢复第三方进程本身。不得据此重复发布、删除或上传。
- 认证、余额、配置、权限、磁盘和证书错误不会作为临时断网无限重试；429/5xx 沿用有限重试规则。
- 重发模型请求可能增加计费；没有返回的用量保持未知，不虚报为零成本。
- 未实际让用户电脑断网/睡眠；自动化使用受控故障和电源事件模拟，真实 Windows 睡眠/唤醒仍建议人工验收。

## 验证记录

专项：15 个自动等待/恢复场景，包括四个并发模型请求、暂停时追加要求、SQLite 控制状态、停止竞争、未知副作用不重放。

浏览器：本地 Edge/Playwright 打开执行记录测试页，验证“等待网络恢复”“手动暂停”“系统暂停”及恢复切换；原有 Agent 数量、并发队列、历史、详情弹窗、窄屏/深色测试均通过，无页面脚本错误。

生产构建通过；保留原有主包体积提醒。本地完整确定性回归 **67/67** 脚本通过；测试源码随本版同步发布。

包内验证通过：

- 独立 Electron 进程加载真实 app.asar，验证电源事件、SQLite 暂停检查点、手动暂停优先和原上下文续跑。
- 真实包内 ConPTY 启动、输入、输出读取及关闭通过，侧栏/侧边聊天模块导入通过。
- **216** 个源码/构建资源逐字节一致；**22** 个终端原生文件正确解包。安装包元数据 SHA-512/大小和版本核对通过。
- 修正旧测试中 Builder 自行运行命令的过时预期；终端测试按时间截止而非输出块数等待，避免 PSReadLine 小块重绘导致假失败。

## 下载与校验

- [便携版](https://github.com/CaptainLand/AporiaX/releases/download/v1.0.0-preview/AporiaX-Portable-1.0.0-preview-x64.exe)（148,120,307 字节）
- [安装版](https://github.com/CaptainLand/AporiaX/releases/download/v1.0.0-preview/AporiaX-Setup-1.0.0-preview-x64.exe)（148,419,462 字节）
- [SHA-256 校验文件](https://github.com/CaptainLand/AporiaX/releases/download/v1.0.0-preview/SHA256SUMS-1.0.0-preview.txt)

安装包未经代码签名，请先退出旧版后更新。旧包保留；本地构建的 latest.yml 仅作为本次 Pre-release 的附件，不替换稳定版 Release 或 Latest 指针。

## English summary

This preview adds automatic waiting for temporary connection loss and continuation after sleep/wake, with shared pause gates for Main, subagents and Builder queues. Manual pauses remain manual; stopped tasks stay stopped. Received task context and receipts are retained, incomplete tool calls are never executed, and uncertain external effects are not replayed automatically.

The package also includes clearer execution records and agent counters, explicit child-result review, on-demand multi-project knowledge, shared workspace/sidebar previews, and first-use model configuration guidance. All 67 regression scripts and packaged recovery/terminal checks passed. Hardware sleep/network testing is still outstanding; app exit, crash, or power-loss recovery remains manual. Reconnecting may incur additional provider charges.

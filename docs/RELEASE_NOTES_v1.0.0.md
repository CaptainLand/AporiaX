# AporiaX 1.0.0 正式版

Windows x64 · 2026-10-15

## 工作台与 Agent 团队

- 统一白天、暗夜和自定义主题下的主对话、执行记录、工作区、项目知识、侧栏与设置；对话表格、文件改动和 Witness 改为扁平化设计。
- 加入可缩放、移动视角的 2.5D Agent 工位；六位角色采用各自头像和形象，工作与休息状态跟随任务记录展示。
- 统一团队中英文命名：阿珀 AporiaX、探奇 Scout、察微 Sentry、验准 Checko、搭匠 Forge、知序 Index。主聊天署名始终显示 AporiaX。
- 新增团队消息、角色私聊与工作群，支持了解工作记录和讨论想法；将消息转成工作要求需要确认，由主 Agent 协调，不因聊天直接执行操作。
- 专业角色改为图形化列表，支持手动配置、AI 设计、简单与高级设置。自定义角色创建／修改／删除逐次确认，内置角色不可删除；受控能力不超过父任务授权。

## 设置、账户与日常使用

- 设置集中管理权限与审批，隐藏原任务设置侧栏入口；执行模式三选一，工作区外文件访问默认关闭并保留风险确认。
- 账户页显示资料、周额度重置时间、Cloud 请求历史、Token 统计与每日用量日历，支持网页账户入口和六位团队头像切换。
- 实验性个性化支持基础配色、主题候选、背景图片和 AI 主题设计，预设白天／暗夜继续可用；额度条、图标、日历和终端随主题适配。
- 合并输入栏附件入口，按类别选择电脑文件、图片、项目引用、Skills 与 MCP；侧栏文件可引用到对话、复制路径或用其他方式打开。
- 修复切换模型后的思考强度状态，调整模型与 API、扩展、角色、通用等设置的视觉一致性。

## 任务结果

- 正常结果只展示“已完成”，不再默认弹出“任务未完成”提醒；原始执行、工具错误和验证依据仍保留供查看。
- 对可继续给出回复的受控停滞场景，允许一次不带工具的总结，说明已有结果与未完成原因；不放宽权限、配额、取消或副作用执行边界。
- 持续保留长任务上下文压缩、临时网络恢复、专业角色预算与 Builder 冲突保护，不把正常输出等同于所有目标均已验证。

## 安装与更新

- 安装器兼容旧客户端的目录定位，保留固定当前安装路径更新及快捷方式修复。
- 稳定版交互安装提供“整理安装副本”：展示可识别副本，确认保留目录与待整理列表后，先安装和校验新版，再把确认的旧程序文件移入可恢复备份。
- 首次安装或选择新位置时，选择父目录后自动创建 `AporiaX` 文件夹；选择已叫 AporiaX 的目录不重复追加。
- 不全盘扫描，不处理无法确认、运行中或更高版本的副本；不删除用户对话、凭据、工作区和混放文档。可跳过整理，静默安装与便携版不自动整理。
- 备份默认位于 `%LOCALAPPDATA%\AporiaX\installation-backups`，包含恢复清单与处理报告。详细说明见 [安装与副本整理](INSTALLATION_ORGANIZER.zh-CN.md)。

## 下载与限制

- 安装版：`AporiaX-Setup-1.0.0-x64.exe`
- 便携版：`AporiaX-Portable-1.0.0-x64.exe`
- 更新元数据：`latest.yml`；增量辅助：安装包 `.blockmap`；完整性校验：`SHA256SUMS-1.0.0.txt`。
- Windows 包仍未做可信代码签名。更新前请从托盘退出旧客户端；已下载的旧安装包不会自行获得新版整理功能。
- 不修改 Cloud 扣费、服务器安全配置或最低客户端版本；本次发布不部署 Web / Cloud。云模型与真实硬件环境的所有组合不可能由本地回归覆盖，失败时保留具体诊断。
- 当前版本使用仓库的源码可用许可；不追溯撤销 RC5.2 及更早已按 MIT 发布副本的权利，第三方组件保持各自许可。

官网：[aporiax.cloud](https://aporiax.cloud) · [GitHub Release](https://github.com/CaptainLand/AporiaX/releases/tag/v1.0.0)

## English summary

AporiaX 1.0.0 brings a unified light/dark workbench, six specialist identities, a 2.5D office, team/private chat, configurable confirmed role management, account history and usage calendar, experimental themes, and centralized permission controls. The stable interactive installer supports confirmed, recoverable organization of recognized old copies and parent-directory installation. Windows packages remain unsigned. No Web/Cloud deployment or billing change is included; historical MIT grants remain valid.

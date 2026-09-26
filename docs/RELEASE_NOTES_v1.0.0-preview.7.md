# AporiaX 1.0.0 Preview 7

2026-09-26 · Windows x64 · Preview, not final 1.0.0.

## 本版变化

- Web 额度页展示全站每日共享 Cloud 额度、已结算费用、进行中占用、待核对占用及下次重置时间；失败时显示未知，不伪装成满额。每 30 秒刷新，回到页面时刷新。
- 个人周额度统一按实际结算显示，不再显示旧的个人预占条。
- 个人周额度或确认的全站已结算剩余额度 ≤5% 时，桌面进入本轮收尾：优先保存和交接、不新增子任务，执行记录显示明确提示。临时全站占用不会触发永久收尾。
- 修复收尾原因在请求身份重建时丢失；保留既有请求幂等、恢复和已付费结果复用，避免因新增提醒重复生成。
- 安装版更新下载发生可重试网络故障时，自动尝试可信备用来源一次；版本、文件名、SHA-512、大小必须一致。校验或证书失败不会被绕过。
- 便携版与更新失败界面新增腾讯云备用下载入口，GitHub 下载入口保留。不会自动覆盖便携版，也不会在任务运行时强制安装。

## 保持不变

- 内测暂限 20 人，全站每日 ¥5，现有个人周额度及并发限制不变。Cloud 最低支持版本暂保留 Preview 4。
- 头像界面保持隐藏；电脑文件、项目与具体对话的后台手机同步通道保持移除。正常模型调用仍会发送必要请求上下文。
- 不自动改用其他模型或自带 API，不删除账号、账单、项目或历史数据。

## 使用与已知边界

推荐安装版使用应用内更新；便携版下载新包，退出旧程序后换包。独立 AporiaX Beta 产品线仍需手动下载一次正式 AporiaX 预览包。

全站剩余额度是共享快照，不是某个任务必能完成的保证。模型收尾提示不能保证最后一次请求精确停在 0%；现有额度耗尽暂停、进度保存和账务核对保护继续生效。

本版为普通 GitHub Release / Latest，版本名仍为 preview。Windows 包未代码签名。模拟模型、隔离 PostgreSQL、浏览器和恢复回归通过；没有据此宣称已完成真实付费长任务或真实系统睡眠验收。

## English summary

Shared daily Cloud allowance is now visible in the account web app. Desktop runs wind down at confirmed personal or global remaining allowance ≤5%, retaining request identity and recovery semantics. Installed builds can retry downloads from a matching trusted mirror; portable builds gain an alternate download entry. Existing quotas, privacy boundaries and minimum client version remain unchanged. Unsigned Windows preview; not final 1.0.0.

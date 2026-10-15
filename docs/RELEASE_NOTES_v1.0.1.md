# AporiaX 1.0.1 安装修复版

Windows x64 · 2026-10-15

- 保留 1.0.0 的新版工作台、Agent 团队、工位、账户与个性化等功能。
- 安装流程恢复为 RC5.2 的原目录覆盖更新：不再提供“整理安装副本”，不跨目录搬动其他程序副本。
- 保留旧客户端的更新目录定位、歧义目录确认和快捷方式修复；不默认迁移到其他盘，不主动删除用户对话、账户配置或工作区。
- 加强发布验收：直接解压实际 Setup 和 Portable，逐文件核对；使用隔离产品标识运行真实安装升级，并在安装后启动完整应用，不仅检查 win-unpacked。
- 初次 1.0.0 已撤回，1.0.1 使用新版本号与独立下载地址，已安装 1.0.0 的用户可检测到此修复版；已下载旧包不会自动变成新包。

## 安装提示

请先从托盘退出旧客户端。安装临时解压仍使用系统临时目录，即使安装到 D 盘也可能占用 C 盘；建议临时盘与目标盘各预留至少 2 GB 可用空间，空间不足时请勿继续安装。此次没有引入新的副本清理或迁移流程。

Windows 安装包仍未做可信代码签名。可核对 Release 的 SHA-256 文件；便携版手动换包。Cloud 后端、计费和最低客户端版本不变。

官网：[aporiax.cloud](https://aporiax.cloud) · [GitHub Release](https://github.com/CaptainLand/AporiaX/releases/tag/v1.0.1)

## English

1.0.1 retains the new 1.0.0 workbench and restores the RC5.2 single-directory overwrite/update installer flow. Installation organization and cross-copy moves are disabled. Actual downloadable payloads are now extracted and compared, with isolated real-installer upgrade/startup acceptance. The initial 1.0.0 distribution is withdrawn; 1.0.1 has distinct versioned assets and is detectable by installed 1.0.0 clients. Exit the old client from its tray first and keep at least 2 GB free on the temporary and destination drives. Packages remain unsigned; Cloud billing and minimum-client policy are unchanged.

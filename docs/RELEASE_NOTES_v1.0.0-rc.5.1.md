# AporiaX 1.0.0-rc.5.1

RC5 的 Windows 更新安装修复版本。官网：https://aporiax.cloud

## 修复

- 自动更新安装时明确使用当前运行的 AporiaX 所在目录，避免其他安装副本的注册信息使新版安装到另一目录。
- 安装后修正已有的桌面和开始菜单快捷方式，使其指向实际安装目录；不会重新创建用户已删除的快捷方式。
- 安装目标异常时阻止安装并保留下载状态，不盲目回退到其他位置。任务执行期间禁止重启安装、下载校验和便携版更新规则保持不变。

## 升级说明

- 已安装 RC5 的用户可以在应用内检查更新。此版本仍是候选版；GitHub 标记为 Latest 以兼容现有更新渠道。
- **旧版本自身的更新器不包含本次路径修复。** 如果机器存在多份 AporiaX，首次升级请在安装向导确认目标目录，或退出应用后手动安装到常用目录。装好 RC5.1 后，后续更新才会自动锁定当前运行目录。
- Windows 安装包仍未签名。对话、项目和用户设置不因本次修复而清空。
- 不改变模型、额度结算、Cloud 后端或网页功能。

## 下载

- 安装版：https://aporiax.cloud/downloads/AporiaX-Setup-1.0.0-rc.5.1-x64.exe
- 便携版：https://aporiax.cloud/downloads/AporiaX-Portable-1.0.0-rc.5.1-x64.exe
- GitHub：https://github.com/CaptainLand/AporiaX/releases/tag/v1.0.0-rc.5.1

升级不会自动删除未注册的旧副本，请确认启动入口及“关于”中的版本。

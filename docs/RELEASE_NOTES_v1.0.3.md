# AporiaX 1.0.3

Windows x64 · 2026-10-19 · 待发布构建

## 社区工坊

- 支持由网页检测本地的 Skill、MCP、基础配色及 Agent，将自建资源统一确认后同步到账号私有仓库；个人仓库同步不会自动投稿。
- 默认五个 Agent、官方 Skill／MCP 可检测，但不能上传；从社区接收的副本保留作者与来源，不作为原创重新投稿。
- 社区作品先导入个人仓库，再由网页请求保存到同账号的 AporiaX。保存成功清除当前设备的 NEW；取消、连接中断、另一台设备或资源被删除不会冒充接收成功。
- 接收只保存：MCP／Agent 默认禁用，Skill 不自动触发，配色不自动应用；不安装依赖或自动扩大工具权限。本地编辑、启用或填入配置后保留接收记录，重试不会覆盖修改。
- 服务端与客户端校验 Agent 合计指令长度、Skill 文档格式与大小，防止提交后才发现无法接收。

## 账户头像

- 客户端选择的六种默认角色头像可保存到云端账号，网页账号、上传者和排行榜使用相同选择。
- 仅同步头像类型，不上传本机头像图片。旧设备选择采用仅首次初始化的迁移方式，避免覆盖已经存在的云端选择。

## 界面细节

- 优化模型切换菜单与思考强度独立入口、档位滑条及拖动性能；隐藏模型较少时的搜索区，弱化教程入口。
- 调整输入栏工具对齐、发送后的 Skill 标记对比度、额度文字与细条，以及文件变更条目的打开方式。
- 保留当前基础个性化、扁平界面及已有图片缩放交互，不重新引入高级组件覆盖或整面板渐变。

## 安装与发布边界

- 沿用原目录覆盖安装，不自动寻找并删除其他旧客户端。用户的对话、账号和工作区不因打包被修改。
- 使用正式域名与账号服务；安装版和便携版分别提供 Windows x64 文件。
- 此目录为待上传产物，尚未更新 GitHub、官网安装包镜像或自动更新通道。社区网页的审核、直发、规则和上架功能由网页／接口独立提供。

## English

Version 1.0.3 adds bounded web-to-desktop community resource saving and account-synced preset avatars, together with model-picker, effort-slider and composer refinements. Community resources are saved without automatic activation, execution, dependency installation or permission elevation. Built-in resources and borrowed community copies are excluded from original uploads. Local edits remain received and are never overwritten by retries. Existing single-directory overwrite installation is retained. These artifacts are prepared locally and have not been published.

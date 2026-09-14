# Git 侧栏第二版

用户已要求升级上一轮建议的完整入门流程，直接执行，不重复请求策划确认。

## 设计规格

用途：在第六个 Git 侧栏内完成仓库初始化、连接与分支管理，让主对话的 Git 工作和人工查看使用同一份真实仓库。范围限于 Git 相关 UI/服务与模型工具说明。

视觉：Industrial/utilitarian。沿用 AporiaX 已有品牌字体 Inter / Segoe UI / Microsoft YaHei，以及 #ffffff、#f8f7f8、#302a37、#5a8eaa、深色 #17141d；作为既有品牌约束覆盖 UI 技能默认字体/配色禁用项。不引入新的 Tailwind 或主题。顶部左侧分支选择，右侧设置与刷新；细节使用现有应用内可关闭弹窗；13px 表单、固定弹窗标题和内部滚动，提交按钮随表单滚动可达。

## 验收与边界

- 无仓库时可初始化；克隆只写入当前空工作区，不覆盖已有文件、不自动清理失败残留。
- 可查看本地分支、新建分支和切换分支；切换/快进拉取前要求干净工作树、无编辑器草稿且没有当前工作区正在执行的 Agent。拒绝强制切换、自动 stash、冲突合并和分支删除。
- 可查看/添加/修改远程，配置当前仓库提交身份。地址不接受密码、令牌、file/ext 协议或任意命令。
- GitHub 登录由用户在交互终端/系统浏览器授权，不让模型读取密码/令牌。身份检查输出白名单字段；不把 gh 原始认证输出送给模型。
- 可在 GitHub 创建并关联私有/公开仓库；默认私有。创建仓库与推送分开，均明确确认；首次推送设置上游。不自动暂存、提交或上传未知文件。
- 所有 Git 变更测试只操作新建临时仓库。GitHub 副作用用受控替身，不创建真实远程仓库、不触发真实登录。
- 主 Agent 保留原有 Git 工具，新增只读认证状态并补足登录与上传边界说明。

## 实施清单

- [x] Git 服务：初始化/克隆/分支/远程/身份/首次推送/快进拉取。
- [x] GitHub 账号状态、交互登录、创建远程与模型工具衔接。
- [x] 分支与仓库设置弹窗、空状态、明确错误与进度。
- [x] 临时真实 Git 仓库、登录/发布替身、浏览器交互和原有回归。
- [x] 构建与交付说明，明确未验证的真实 GitHub 授权/网络分支。

## 使用路径

1. 打开空侧栏，选第六项 **Git**。已有仓库直接显示真实分支和改动；新目录可初始化，空目录可克隆。
2. 点击顶部当前分支，新建或切换本地分支。点击右侧仓库设置，配置远程、提交署名和 GitHub 登录。
3. GitHub 页的“浏览器登录”创建交互终端，执行固定的 `gh auth login --web` 流程。用户按终端提示操作并在系统浏览器授权，成功后自动配置 Git 凭据助手；返回 GitHub 页刷新身份。
4. 绑定现有远程不上传文件。新建 GitHub 仓库默认私有、要求已有本地提交；创建完成后通过“发布分支”单独确认上传目的地。既有上游可推送或快进拉取。
5. 对主 Agent 可以说：“检查 GitHub 登录，把当前项目关联到我的指定仓库，先别推送。” Agent 可使用已有 Git/PR 工具，新增 `github_auth_status` 返回白名单状态；缺少授权时引导用户到上述 UI。AporiaX 账号登录不等于 GitHub 登录。

## 验证记录（2026-09-14）

- `npm run test:workbench-git-setup`：通过。临时真实仓库验证初始化、不覆盖 ignore、分支、未提交保护、远程确认/过期状态、首次推送及上游、快进拉取和空目录克隆。浏览器覆盖表单、未保存草稿、模拟授权终端、默认私有仓库创建、关闭/Esc、窄屏深浅主题与不透明弹窗。
- `npm run test:workbench-git-setup-electron`：通过。真实 Electron 主进程服务验证同工作区重叠任务的保护、全部释放后恢复、其他工作区不受影响。
- `npm run test:side-chat`、`npm run test:workbench-documents-git`、`npm run test:workbench-state`：通过，复用的弹窗、文档预览、旧 Git 流程与侧栏状态未回归。
- `tests/github-workflow-smoke.mjs`、`tool-permissions-smoke.mjs`、`capability-registry-smoke.mjs`、`native-tool-executor-smoke.mjs`、`native-tool-catalog-smoke.mjs`：通过。
- Electron `tests/workbench-lifecycle.cjs`：通过。浏览器关闭后停止请求，交互终端 Ctrl+C 后回到可用 Shell，Shell 退出/标签销毁正常。
- `npm run build`：通过；仍有原有主包体积超过 500 kB 的提示。`git diff --check` 无空白错误（Git 提示 LF/CRLF 转换属于现有环境配置）。
- 截图：`.tmp/workbench-git-v2/branches-light.png`、`github-light.png`、`remotes-dark-narrow.png`。没有可用 agent-browser 工具，使用项目现有 Playwright + Edge 流程验证实际 React UI。

真实 GitHub 浏览器授权、用户账号下的仓库创建/推送未执行；相关分支通过受控替身验证，不应据此宣称已连接用户账号。未调用付费模型、未上传当前项目、未打安装包、未提交或推送工作区改动。已更新 `dist`，重启源码版 `npm start` 可体验；已有安装版需要另行打包才包含改动。

本版不提供远程分支自动检出、分支删除、stash、冲突编辑器、强制推送或图形化 PR 管理；这些可继续使用终端/主 Agent 的受控工作流。SSH 克隆依赖用户已有 SSH 密钥与主机信任配置；首次设置建议走 HTTPS + GitHub 浏览器登录。

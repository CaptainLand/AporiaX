# 终端第二版（第一阶段）

范围已由用户确认。按规格、UI 设计、前端验证技能落实；不更改 Agent 权限、不部署、不启动用户项目中的服务器。

## 设计

- 用途：让用户在侧栏直接工作，保留真实 Shell 和既有 Ctrl+C 语义。
- 风格：Industrial/utilitarian。一行紧凑工具栏，按需搜索和菜单，不常驻第三层使用说明。
- 品牌：浅色 #ffffff / #f8f7f8 / #302a37 / #5a8eaa，深色 #17141d / #e0dce8。沿用品牌而非引入新配色，覆盖技能默认的品牌色限制。
- 字体：终端 Cascadia Mono / Consolas / Microsoft YaHei fallback，默认 14px，可独立缩放；应用按钮沿用原字体。
- 主题：默认跟随应用，可选独立浅色/深色。不默认发光，不拉伸终端 canvas。

## 验收

- 当切换标签、任务或收起侧栏时，保留内存中的终端实例、选区及滚动位置；关闭标签成功后才销毁实例和 Shell。
- 当 Shell 退出时，读完剩余分页输出后再停止；保留滚动缓冲区上限，发生截断时明确提示，不冒充完整日志。
- 用户主动新建终端时聚焦；Agent 自动展示和普通标签恢复不抢聊天输入焦点。
- 提供搜索、复制/粘贴/全选/清屏、回到底部、主题/字号、重命名及关闭会话。
- 有选区 Ctrl+C 复制，无选区传给 Shell；多行/控制字符粘贴先预览确认，不能绕过确认发送。
- 后台轮询降频，数据分块送给 xterm 并等待解析确认，无输出时不反复更新 React。
- 保留网页链接；本地路径跳转和完整 Shell 集成属于第二阶段，不猜测当前目录或命令状态。

## 工作清单

- [x] 输出分页、UTF-16 边界、退出尾部与资源生命周期。
- [x] 会话级 xterm 缓存、滚动/选区、受控输入与搜索。
- [x] 紧凑工具栏、深浅主题、缩放、菜单和粘贴弹窗。
- [x] 浏览器与 Electron 回归、构建、交付记录。

## 基线

`node tests/workbench-repairs-browser.mjs` 已运行：旧测试明确要求切回标签再次从 cursor=0 读取，验证了重建/重放现状。截图固定深色、三层工具条。退出读取分支在未检查剩余数据时停止，按静态检查新增专项验证。

无 agent-browser 工具，采用本项目已有 Playwright + Edge 以及隔离的 Electron 测试。不会操作真实 GitHub、账号或现有后台服务。第二阶段：Shell 选择/目录与命令边界集成、Agent PTY 交接、持久化历史（不自动重跑命令）。

## 实现与验证（2026-09-14）

- 新增 `TerminalPane.jsx`、`terminal-session.js`、`terminal.css`，终端样式与生命周期从 WorkbenchPanes 分离；主题偏好仅保存主题和字号，不保存终端内容到 localStorage。
- 采用官方 `@xterm/addon-search@0.16.0`，匹配现有 xterm 6。新增唯一依赖及锁文件记录。
- 输出读取返回 `hasMore/endCursor`；每包等待 xterm 解析完成才推进游标。活跃输出快速续读、无输出 750ms / 隐藏 1500ms 轮询，传输错误退避重试。不是无界事件推送，也不是全量日志持久化。
- 后端最多保留 400,000 UTF-16 字符，前端最多 5,000 行滚动历史；大于上限时显示截断提示。已退出终端不会因新建其他终端而删除。最多 12 个活跃同类会话、24 个含退出历史的同类资源，关闭标签回收。
- 交互 PTY 不再自动注入 CI/NO_COLOR，但保留调用环境显式配置和原有凭据过滤。Agent 管道进程保持原逻辑。
- 工具栏目录明确是“初始目录”，状态点只表示 Shell 连接/退出，不猜测命令执行状态。重新打开并不自动运行旧命令。

### 已通过

1. `npm run test:terminal-v2`：缓冲区分页与 Unicode、环境过滤；真实 xterm 浏览器交互；真实 PowerShell PTY 输出 160K 以上后退出仍可读取尾部，新建后保留已退出日志、作用域检查。
2. 浏览器路由 `/tests/fixtures/terminal-v2.html`：用户新建聚焦、Agent 展示不抢焦点，切换/收起后相同实例/选区/滚动位置、搜索上下匹配、选中 Ctrl+C 复制/未选中发送中断、快捷键和原生 paste 两条入口均先确认多行内容、主题跟随与独立设置、字号/名称、窄屏菜单、末尾多页输出、失败关闭保留实例、成功关闭销毁、暂时读取失败恢复、后台持续接收与空闲降频；无页面异常。
3. `tests/workbench-repairs-browser.mjs`：旧侧栏回归通过，原“切回重新读取 cursor=0”断言改成“同一个实例且只读一次开头”；符合本次明确变更的行为。
4. `npm run test:side-chat`、`npm run test:workbench-git-setup`、`tests/workbench-state-smoke.mjs`、`tests/workbench-present-smoke.mjs`、`tests/native-tool-executor-smoke.mjs`：通过。
5. Electron `tests/workbench-lifecycle.cjs`：关闭浏览器停止请求、Ctrl+C 后 Shell 可继续输入、退出后可读、关闭标签销毁均通过。
6. `npm run build`：通过，仍有既有主包超过 500kB 的警告；搜索扩展与 UI 约增加 14kB gzip。没有配置独立 linter/typecheck 脚本，执行了相关 Node 语法检查和真实浏览器构建。
7. `npm run test:workbench-documents-git`：文档格式预览/源码编辑、DOCX 页面、Git 侧栏与临时仓库回归通过；没有修改用户仓库或远端。

截图：`.tmp/terminal-v2/light.png`、`.tmp/terminal-v2/dark-narrow.png`。剪贴板交互在浏览器替身中验证；原生测试只验证拒绝边界，没有读写用户真实剪贴板。没有连接真实账号或执行用户项目任务，测试 Shell 已关闭。

体验：重启源码版 `npm start`，在侧栏打开终端；搜索在右上角放大镜，主题/字号/复制粘贴/重命名/结束会话位于右上角菜单或右键菜单。已有终端需要使用新代码启动的应用才会生效。尚未制作安装包、提交或推送 GitHub。

## 输入延迟、光标与任务栏图标修复（2026-09-14）

- 根因：输入写入 PTY 后仍等待 750ms 空闲读取周期；此前仅分别测试输入 IPC 和输出，遗漏了真实 ConPTY → IPC → xterm 的按键回显延迟。新增完整原生 UI 测试，修复前测到 143 / 514 / 514 / 514ms。
- 读取协议增加可选 `waitMs` 和 `waitSupported`：无输出时在后端等待，有输出或进程退出立即返回；最多等待 1500ms，每个终端最多 4 个未完成读取，超时/退出及时移除等待者。前端仍只允许一个在途读取，并等待 xterm 解析完成，避免无界推送。旧后端兼容路径会在输入时立即唤醒并短暂快速读取。没有放宽任务作用域与输入权限。
- 视觉规格沿用上一版 Industrial/utilitarian 终端：14px Cascadia Mono / Consolas、白底 `#ffffff` 与深底 `#17141d`，光标对应 `#302a37` / `#e0dce8`。不修改布局和品牌色；聚焦时显示不闪烁的高对比方块，失焦仍为空心光标；只修饰 xterm 的真实光标元素，应用主动隐藏光标仍生效。
- 此机原生测试没有复现“光标始终不存在”，但复现了闪烁与慢回显。新增检查覆盖光标尺寸/颜色/无闪烁、深浅主题、切回标签点击恢复焦点，以及 ANSI 隐藏/显示/请求闪烁。
- 图标：`build/icon.png` 的 AX 宽度约为画布 42%，而窗口/托盘本来已选择大图标 `icon-dark.ico`。统一 `build.win.icon` 为已有的 `icon-dark.ico`，无需改图或新依赖。逐帧解码验证 16 / 24 / 32 / 48 / 64 / 128 / 256px，其 AX 宽度为 69–75%，图标与窗口资源一致。没有修改或清除用户 Windows 图标缓存；现有 EXE/固定快捷方式需要下一次重新打包更新才能换图标。

验证：

- `npm run test:terminal-v2` 通过：输出等待/唤醒/并发限制/超时/退出清理；真实浏览器旧接口延迟回显约 87ms；搜索、粘贴、历史、完整尾部输出与原生 PTY 回归全部通过。
- `node tests/terminal-native-ui.mjs` 通过：最终一次原生回显为 71 / 8 / 12 / 7ms（本机样本，不承诺所有机器固定延迟），主题/光标/重新聚焦通过。仅创建临时目录与测试 Shell，未执行用户项目命令；测试会话已关闭。
- `electron tests/desktop-icon-smoke.cjs` 通过；以上两项可用 `npm run test:terminal-interaction` 复跑。
- `node tests/workbench-repairs-browser.mjs`、`electron tests/workbench-lifecycle.cjs` 与 `npm run build` 通过。仍只有既有主包 >500kB 警告，未新增依赖。
- 原生截图：`.tmp/terminal-v2/native-cursor.png`。隐藏 Electron 窗口的 CDP 截图两次超时，改用 Electron 文档提供的 `capturePage(undefined, { stayHidden: true, stayAwake: true })` 后成功，未为截图显示窗口或影响用户任务。

本次未打包、未提交/推送；源码终端修复可重启 `npm start` 体验。

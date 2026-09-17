# AporiaX 0.9.8

日期：2026-09-17。Windows x64 Preview。相对 `v0.9.7` / `c021fbb` 的可靠性跟进，含 [#62](https://github.com/CaptainLand/AporiaX/pull/62) 与暂时隐藏 OCR 界面入口。

## 本版更新

### 任务历史

- 旧列表迁移写入 pending / partial / completed 标记；失败记录可重试，归档失败时不删除原件。
- 损坏的单条任务不再挡住健康历史；损坏索引只读加载，不自动覆盖。
- 任务文件已落盘但迁移索引未提交时，保留较新内容并补回索引。
- 保存使用随机临时文件、fsync 和串行写入，并校验 revision。删除必须显式指定，原件进入墓碑目录，不再按旧列表隐式清理。
- 首次加载失败时暂停自动保存，避免空缓存覆盖原件。

### 文件写入与 Builder

- 普通写入、两种补丁路径和 Office 写入与 Builder 合并共用可恢复提交：写前备份、意图记录、失败后可查。
- 显式编排复用委派 Builder 的快照、合并与保留工作树。Kernel 默认并发 6，不再把设置 6 静默压成 4。拒绝重复调度 ID。
- 启动阶段即计入托盘和升级保护，包含 detached / Core HTTP 任务。

### Safe、OCR、读取与边界

- 同一任务的成功命令之间保留私有依赖副本；manifest 变化使缓存失效；不共享或写回宿主 `node_modules`。Isolated 在 Docker 不可用时拒绝执行，不再静默降级。
- OCR 把 Canvas/WASM 放到可终止子进程，混合图文页补识别，支持强制 OCR，解码前做尺寸预检。输入栏、附件和侧栏的 OCR 按钮暂时隐藏，引擎仍保留。
- 文本读取改为流式哈希、有界内存、超长行按 offset 前进，并校验 UTF-8。
- 特权 IPC 统一校验主窗口、主 Frame 和应用来源。MCP 超时与取消传到 SDK；远端副作用仍可能已发生，不以“已撤销”重放。
- Windows 规范化临时目录、工作树、扩展目录和依赖副本的真实路径，保留链接越界拒绝。

Docker 沙箱镜像升到 Node 22.16，并更换标签以免复用旧 Node 20 镜像。发布通道区分预览与正式；本包按正式 `latest` 发布。

## 验证

[#62](https://github.com/CaptainLand/AporiaX/pull/62) 的 Linux/Windows 回归矩阵与桌面门禁已通过。本机另做 Windows Setup / Portable 打包与包内源码/哈希校验。生产构建仍可能出现主 JS chunk 较大的告警。

干净设备安装、旧版本升级实测、Windows 发行签名和真实模型任务基准仍需独立验收。

## 尚未包含

- Core 仍在 Electron Main，不是独立监督进程。
- Safe 仍是工作区副本保护，不是 Windows AppContainer。
- OCR 子进程和 V8 heap 配置不是原生 RSS 硬上限。
- 多任务切换时侧栏可能闪一帧旧标签、后台 `present_to_user` 文件页可能丢失，本版未改。

执行 `npm start` 可查看本地开发版。可靠性专项为 `npm run test:audit-suite`。

# 有限次数提问与桌面提醒（本地开发版）

## 用户体验

- 主 Agent 可调用 request_user_input。策略要求先检查已有信息，只有关键方向或必要参数不确定、选错会明显偏离目标时才问；日常调试和可逆小细节不应打断用户。
- 每个原始用户请求最多 2 题，每次 1 题。第二题需要新的成功工具证据或用户补充。重试、恢复和回答不刷新额度；明确重复的问题被拦截。模型连续 3 批无效提问后停止空转，返回受阻。
- 2–4 个单选项（至多一个推荐标记），始终有“自己填写”；也支持纯文本题。推荐项不预选、不自动提交。
- 在对话中回答；右下角提醒显示摘要、“去回答”和“稍后”。“去回答”打开对应任务并定位提问；关闭/超时不回答。复用审批提醒窗，一次展示最新提醒，未答卡片仍然保留。
- 等待时保存状态、不轮询模型。提交后继续原任务；手动、网络和睡眠暂停不会被答案清除。已经开始的外部进程不会被强行终止。
- 可以停止任务。应用重启后，通过原任务的恢复入口接回同一个问题；若答案已保存但模型回执未保存，修复回执，不重新提问。

## 数据与授权

问题、答案和次数在本地 aporiax-runs.sqlite3 的 user_clarifications 表保存，采用版本比较写入；落盘失败则停止继续执行。回答仅接受可信桌面 IPC，校验运行、问题身份、客户端归属、选项与文本长度。

提问不是权限审批，不产生批准票据，不绕过命令/文件工具权限。新的补充要求会使已有任务验收和普通子 Agent 结果重新待验收。

没有新增云端收件箱、手机同步、电脑文件/项目同步或远程上传接口。答案随后作为正常推理上下文发送给所选模型服务，这不等于完全离线。不要在回答中填写密码或 API Key。

上限、单题并发、原始任务身份和明确重复拦截由程序执行；问题是否值得问、不同表述是否同义仍依赖模型策略，不承诺完美语义判断。需要支持工具调用的模型。

## 验证

- tests/user-clarification.mjs：schema、幂等/并发、预算/新证据、取消、SQLite CAS/重开、IPC 归属、恢复先于执行、Witness 与提醒文案。
- tests/user-clarification-runtime.mjs：模拟模型真实循环，等待零轮询、答案进入人类上下文、子 Agent/混合工具批拒绝、连续无效提问停止、已答未回执崩溃恢复。未调用真实付费 API。
- tests/user-clarification-browser.mjs：单选/自填/纯文本、提交失败保留、取消/恢复、浅深色/窄窗口，以及完整 App 跨任务、从执行记录返回具体问题。
- tests/user-clarification-toast.cjs：隔离 Electron 窗口，右下角位置、可信发送方、稍后/去回答、任务定向关闭、原审批与超时无决定。输出 .tmp/user-clarification/toast-result.json。
- 回归：automatic-task-suspension、approval-response-regression、runtime-context-recovery、native-tool-catalog、tool-permissions、privacy-no-sync、harness-event-hook、task-history-store、approval-toast；生产前端构建。

运行 npm run test:clarification。构建后重新启动源码版 npm start 预览。本次没有上传服务器、推送 GitHub、改变版本号或发布安装包。

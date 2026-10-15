# Agent 工位

桌面端「项目知识 / Understanding」右侧的新独立任务视图。使用本地 Three.js 程序化场景，无 CDN、远程资源或独立预览服务依赖。此功能不改变调度、模型选择、权限或扣费规则。

## 数据与控制

- 主管代表当前任务最新一轮；已配置角色从专业角色设置读取，运行实例来自该轮的 `subagents` 与 Witness 记录。
- 只有附着的活动运行才显示实时状态。模型连接活动不等于正文输出或工具进展；模型等待、排队、依赖、审批、暂停和失败分别显示。
- 同一角色的多个实际实例分别占座；每区最多 5 个子 Agent，主管固定出现。列表可访问全部实例及自定义角色。
- 工位详情显示职责、任务、模型、已有 Token/请求统计与结果。不推算未知用量或费用。
- 主管追加要求/暂停/继续/停止复用主聊天控制。子 Agent 追加要求/停止复用受保护的 `agentProfiles` 接口，仍校验 taskId/runId/agentId，不绕过审批。
- 页面可见且运行活动时，每 1.8 秒通过现有只读接口补齐队列、预算与状态；新事件使较旧的快照失效。页面本身不发送模型请求。

## 生命周期

场景按需加载，继承应用日夜主题。离开视图释放场景、GPU 上下文、事件和轮询；隐藏窗口暂停动画与轮询。可独立暂停动画，不影响任务。无 WebGL 时保留角色列表和操作，提供重试入口。

## 验证

```text
node tests/agent-office-model.mjs
npm run build
node tests/agent-office-browser.mjs --production
node tests/agent-office-electron.mjs
```

浏览器测试使用合成任务和模拟 IPC，但运行真实主界面与事件处理；Electron 测试使用独立临时用户目录与真实专业角色 IPC，不读取真实任务、不调用付费模型。演示截图位于 `output/agent-office/integrated-light.png` 与 `integrated-dark.png`。

2026-10-13：构建、上述专项检查、专业角色模型与界面、Agent 活动界面、日夜布局一致性检查通过。较旧的 `renderer-modules-smoke.mjs` 在 `coverBrowser` 的精确字符串断言处失败：断言没有包含此前已接入的 `externalControlOpen`，与本次工位改动无关；未为本功能修改该旧检查。未进行付费模型端到端调用或发布新安装包。

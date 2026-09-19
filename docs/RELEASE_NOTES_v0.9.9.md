# AporiaX 0.9.9 — Harness 长任务循环更新

发布日期：2026-09-19。Windows x64，Preview 阶段。

本版包含 PR [#63](https://github.com/CaptainLand/AporiaX/pull/63)、[#64](https://github.com/CaptainLand/AporiaX/pull/64) 及合并前的审查修复。它是一次较大的 Harness 工程改进：重点是让长任务少丢决策、少做无效查询、遇到错误能有限恢复并及时换路，而不是改变模型本身的智力。

## 下载与更新

- [Windows 安装版](https://github.com/CaptainLand/AporiaX/releases/download/v0.9.9/AporiaX-Setup-0.9.9-x64.exe)
- [Windows 便携版](https://github.com/CaptainLand/AporiaX/releases/download/v0.9.9/AporiaX-Portable-0.9.9-x64.exe)
- [SHA-256 校验清单](https://github.com/CaptainLand/AporiaX/releases/download/v0.9.9/SHA256SUMS-0.9.9.txt)

先退出旧版再安装或启动便携版。安装包未代码签名；请核对下载来源与校验值。不要同时用两个版本打开同一用户数据目录。旧版任务与配置沿用既有存储机制；更新前建议备份用户数据。

## 与 0.9.8 相比，进步在哪里？

| 环节 | 0.9.8 的基础 | 0.9.9 的增量 | 对实际工作的意义 |
| --- | --- | --- | --- |
| 长任务上下文 | 已有持久任务记录、压缩和置顶约束 | 有来源的决策、否决方案、待确认问题保存到有版本控制的 TaskBrief；保留诊断、文件哈希与完整结果引用 | 降低压缩后重走旧路和丢失关键依据的风险；不等于无限上下文 |
| 工具调度 | 已有并发读取和串行写入保护 | 主/子 Agent 共用连续只读池与排他屏障，按原调用顺序返回结果，退出前收尾已启动工作 | 减少不必要的串行等待，同时避免跨写入乱序；读取并发仍为 4 |
| 后台进程 | 已有启动、读取、停止能力 | 按输出、退出、取消或用户新指示唤醒等待，安静的进程不被视为失败 | 编译、服务器和长命令无需反复询问“结束了吗” |
| 模型异常 | 已有错误报告与重试 | 上下文溢出最多两次有效缩减；输出截断/工具协议问题采用有限纠正；不执行残缺或重复的工具调用 | 部分可恢复错误不必直接终止任务，也不无限重试 |
| 无效循环 | 已有状态与活动记录 | 识别重复失败及 A/B 来回修改；默认给出重规划建议，严格模式按问题单独计预算 | 提醒换策略；不因一个旧错误永久阻断无关后续操作 |
| 任务验收 | 已有 Agent 主导验证和诚实交付状态 | 可选契约检查文件、内容、JSON 和已有命令收据，并核对声明输入的哈希 | 验收有明确证据；评估器本身不运行 npm test 或其他命令 |
| Provider 与可观测性 | 已有兼容 Chat、部分缓存统计 | 可选原生协议、请求/尝试/重试/耗时与用量记录；修正上下文估算重复计费式偏差 | 更容易定位卡顿和无效请求；估算修正不是实际账单优惠 |

**总体判断：长任务可靠性和调度完整度有明显提升，简单的一问一答或单步编辑变化较小。尚未做真实模型、固定任务集的 0.9.8/0.9.9 对照，因此没有可靠的提速倍数、成功率提升百分比或 Token 节省比例。**

## 默认行为与可选功能

- 重规划默认是建议，不是新的全局硬门槛。严格模式可配置每个问题的预算（0–4，默认值 2；0 关闭预算门槛）；成功或新指示会按策略解除旧问题。诊断/替代路径仍经过原有权限检查。
- TaskBrief 是有边界、有来源的公开任务摘要，不采集或向用户展示模型隐藏思维链。它不覆盖用户原始要求，也不将历史或检索内容提升为用户授权。
- 大工具结果可归档到现有任务证据存储，再通过 `mcp_read_result` 分页回读。受存储配额和工具范围限制，不会为取结果重新执行副作用操作。
- 可选验收契约从任务配置或 `.aporiax/acceptance.json` 加载。没有合适证据时保持未验证/需人工确认；有限续做后仍不满足条件会保留产物并诚实报告状态。结构检查不等于语义质量证明。
- DeepSeek Chat、OpenAI Responses、Anthropic Messages 的原生协议需要显式选择；兼容 Chat 仍为默认，Cloud 不会被偷偷切换。Responses 使用 `store:false`，原生状态与相应 Provider/模型/消息绑定。
- Builder 数量、角色边界、审批权限、工作区与副作用恢复保护未在本版放宽；这次不是“更多 Builder”或新的操作系统级沙箱。

## 验证依据

合并后的运行时代码已完成 54/54 组本地审计脚本、57 项目标闭环用例、7 个目标设置 UI 场景；PR 最终提交的 GitHub 7/7 项检查通过，其中包含跨平台 Node 检查及 Windows 桌面、Electron、ASAR 和打包校验。以上是互有包含关系的测试集合，不能相加当作独立测试数量。

- [CI 检查记录](https://github.com/CaptainLand/AporiaX/actions/runs/35446659534)
- [审计与桌面检查记录](https://github.com/CaptainLand/AporiaX/actions/runs/35446659546)

0.9.9 发布流程另核对版本标签与源码一致性、重跑本地发布检查，并逐文件校验包内源码、渲染产物及原生依赖，生成安装版/便携版和更新元数据的校验清单。只有检查通过的产物才发布。

## 已知限制与后续方向

- 原生协议已通过模拟服务与回归测试，但本轮没有调用付费真实模型 API；真实服务兼容性、长任务成功率、Token 与耗时 A/B 测试仍待补齐。
- 没有新增系统级隔离；Safe 仍是工作区副本机制，不是 Windows AppContainer。
- 依赖锁未在本版升级；此前 CI 的依赖审计仍报告 14 项告警（1 low、4 moderate、9 high），不能宣称依赖安全清零。告警数量不等同于已经证明存在的运行时可利用漏洞。
- 前端构建仍有大 chunk 提示；全新 Windows 环境与各种旧版用户数据的完整安装/升级矩阵尚未覆盖。

## English summary

0.9.9 is a substantial Harness engineering update, not a model-intelligence upgrade. It adds source-backed task decisions, evidence-preserving compaction, shared ordered tool scheduling, event-driven process waits, bounded inference repairs, advisory/optional strict replanning, optional evidence-based acceptance contracts, and opt-in native provider protocols. Existing permissions and workspace protections remain unchanged.

The merged runtime passed local and CI regression gates, including desktop/package checks. Live paid-provider validation and controlled 0.9.8-versus-0.9.9 task benchmarks remain outstanding; no speed, success-rate, or billing-savings percentage is claimed. Windows binaries are unsigned and the product remains at Preview maturity.

# AporiaX 0.5.0

> Adaptive · Observable · Conflict-safe Multi-Agent Harness

**中文** · [English](#english)

AporiaX 0.5.0 是一次面向 Harness 的核心升级：它不再只是在一个主 Agent 周围增加更多子 Agent，而是开始形成一套**自适应、可观察、可冲突隔离的多 Agent 工程执行系统**。

## 中文

### 版本重点

#### 1. Adaptive Agent Budget：按任务复杂度决定要不要多 Agent

AporiaX 不会为了“多 Agent”而无条件增加调用成本。简单任务可以保持 Main-only；只有当任务需要更深探索、跨模块修改、审查、验证、项目理解或明确委派时，Harness 才会开放额外 Agent 预算。

- 简单任务保持 Main-only。
- Explore / Review / Verify 等只在需要时出现。
- 符合条件的大型写任务最多启用 2 个 Builder。
- Agent 总数、并发和角色容量均有硬上限。

#### 2. Main + 最多 2 个 Builder

0.5.0 引入真正可写的 Builder，但 Builder 永远不是第二个 Main。

Main 负责：

- 任务拆解与最终决策；
- 共享文件与跨模块边界；
- Builder 结果集成；
- 最终 Review / Verify 之后的交付。

Builder 负责在明确 scope 内实现独立模块，并在独立 Git worktree 中工作。

#### 3. Scope Lease + 隔离 worktree + 冲突安全合并

Builder 的写权限被绑定到显式 scope：

- 越界修改在合入真实工作区前拒绝；
- Builder 不允许递归委派 Agent；
- 合并前检查基线和并发改动；
- 用户或 Main 同时修改的内容不会被静默覆盖；
- dirty workspace 通过 overlay 保留，并在最终集成时做冲突检查；
- 二进制 Builder 变更不会走不安全的文本合并路径。

#### 4. Collaboration v1：Shared Contract / Plan Approval / Handoff

即使两个 Builder 不修改同一个文件，也可能在 API、UI、Schema、状态语义或安全约束上产生冲突。0.5.0 因此新增协作协议层：

- **Shared Contract**：定义跨 Builder 必须共同遵守的不变量和验收条件；
- **Plan Approval**：scope、依赖、Contract key、共享文件责任明确后才允许并行；
- **Structured Handoff**：Builder 返回摘要、假设、Main 待处理事项、contract assertions 和消息；
- **Bounded Mailbox**：允许 question / notice / blocker，但不提供无限制实时 peer chat；
- **Semantic disagreement detection**：在 Builder wave 结束后检查跨 Builder 语义分歧。

Main 始终保留最终集成权。

#### 5. Review / Verify / Witness 继续作为独立质量链路

- **Review**：语义、实现与静态质量检查；
- **Verify**：build / test / lint / typecheck / runtime 证据；
- **Witness**：只观察，不修改文件，记录 Main / 子 Agent、耗时、失败与协作状态；
- Review / Verify 与当前文件版本绑定，避免旧验证结果为新代码背书。

#### 6. Harness Architecture v1

0.5.0 开始把巨型 Runtime 拆成更清晰的 Harness 边界：

- Event Bus + Hook API
- Declarative Agent Definition
- Session / Scheduler / Context / Tool / Review 等模块边界
- Plugin API
- loopback-only Core Server / Desktop Client 基础

> Core HTTP `taskRpc` 在 0.5.0 仍然关闭。当前版本建立了 Core 架构基础，但不是一个在桌面进程退出后仍能独立运行的 daemon。

#### 7. Windows 后台与托盘体验

- 点击关闭按钮时，AporiaX 隐藏到系统托盘，正在执行的任务继续运行；
- 托盘可恢复窗口，也提供真正的 Exit AporiaX；
- Dialogue 显示任务 elapsed time；
- 托盘状态实时显示正在运行任务的耗时；
- 隐藏状态下完成任务时发送 Windows/Electron 系统通知；
- 首次关闭到托盘时显示一次说明；
- 重复的应用内完成提示被抑制。

> 关闭到托盘依赖当前 Electron 进程继续存在。完全退出进程或重启电脑后，进行中的任务不会自动续跑。

### 稳定性修复

最终 0.5.0 regression pass 还修复了：

- Harness v2 smoke fixture 与 Collaboration v1 Shared Contract / Plan Approval 规则的兼容；
- 显式 Explore / background Explore 请求的 Adaptive Agent Budget 分类；
- 中文 `创建` 写意图；
- `self-check` / `自检` / `复核` / `校验` 验证意图；
- 显式 durable Remember / `记住` 请求触发 Curator 时的预算问题。

### Windows Release Gate

最终候选版本通过：

- `npm run test:desktop-background`
- `npm run test:collaboration`
- `npm run test:harness-v2`
- `npm run test:architecture`
- `npm run test:cache`
- `npm run test:runtime`
- `npm run build`
- Electron 启动与 Windows 托盘 / 后台生命周期人工检查

### 下载

- **Setup**: `AporiaX-Setup-0.5.0-x64.exe`
- **Portable**: `AporiaX-Portable-0.5.0-x64.exe`
- **SHA256**: `SHA256SUMS.txt`

### 已知边界

- Core HTTP `taskRpc` 仍关闭；凭据、审批、pause/resume 和 mutation control 仍在桌面 Runtime 内。
- 任务尚不能跨完整进程退出 / 重启继续执行。
- 部分 legacy 只读子 Agent 路径仍使用 compatibility-runtime internals。
- Collaboration v1 不提供无限制实时 peer-to-peer Agent 聊天。

---

<a id="english"></a>

## English

AporiaX 0.5.0 is a major Harness milestone. Instead of simply surrounding one agent with more subagents, it starts to form an **adaptive, observable, and conflict-safe multi-agent engineering system**.

### Highlights

#### 1. Adaptive Agent Budget

AporiaX does not add agents just to look “multi-agent.” Simple work can remain Main-only. Additional capacity is opened only when the task needs deeper investigation, cross-module changes, review, verification, durable project understanding, or explicit delegation.

- Simple tasks can stay Main-only.
- Explore / Review / Verify appear only when useful.
- Eligible large write tasks can use up to 2 Builders.
- Total agents, concurrency, and role capacity are hard-bounded.

#### 2. Main + up to 2 Builders

0.5.0 introduces real writable Builders, but a Builder is never a peer Main agent.

Main owns:

- decomposition and final decisions;
- shared files and cross-module boundaries;
- integration of Builder output;
- final delivery after Review / Verify.

Builders implement independent scopes inside isolated Git worktrees.

#### 3. Scope Lease + isolated worktrees + conflict-safe merge-back

Builder writes are constrained by explicit scopes:

- out-of-scope changes are rejected before merge-back;
- Builders cannot recursively delegate agents;
- baseline and concurrent workspace edits are checked before integration;
- user/Main changes are never silently overwritten;
- dirty workspaces are preserved through an overlay and conflict-checked during integration;
- binary Builder changes are rejected from unsafe text merge paths.

#### 4. Collaboration v1: Shared Contract / Plan Approval / Handoff

Builders can disagree on APIs, UI behavior, schemas, state semantics, or security even without editing the same file. 0.5.0 adds a collaboration protocol layer:

- **Shared Contract** for cross-Builder invariants and acceptance criteria;
- **Plan Approval** before parallel execution;
- **Structured Handoff** with summaries, assumptions, Main follow-ups, contract assertions, and messages;
- **Bounded Mailbox** for questions, notices, and blockers without unrestricted live peer chat;
- **Semantic disagreement detection** after Builder waves.

Main always remains the final integration authority.

#### 5. Independent Review / Verify / Witness quality chain

- **Review** focuses on semantic, implementation, and static quality.
- **Verify** focuses on build / test / lint / typecheck / runtime evidence.
- **Witness** is observation-only and records Main/subagent actions, timing, failures, and collaboration state.
- Review / Verify results are matched to the current file version so stale evidence cannot certify newer code.

#### 6. Harness Architecture v1

0.5.0 begins splitting the giant Runtime into clearer Harness boundaries:

- Event Bus + Hook API
- Declarative Agent Definition
- Session / Scheduler / Context / Tool / Review boundaries
- Plugin API
- loopback-only Core Server / Desktop Client foundation

> Core HTTP `taskRpc` is still disabled in 0.5.0. This release establishes the Core foundation but does not claim detached-daemon execution after the desktop process exits.

#### 7. Windows background and tray experience

- Closing the main window hides AporiaX to the Windows tray while active tasks continue.
- The tray restores the window and provides a real Exit AporiaX action.
- Dialogue shows elapsed task time.
- Tray status shows live runtime for active work.
- Hidden-task completion uses Windows/Electron system notifications.
- A one-time first-close notification explains that work continues in the tray.
- Duplicate in-app completion notifications are suppressed.

> Background continuation depends on the current Electron process remaining alive. Active tasks do not survive a full process exit or machine restart yet.

### Stabilization fixes

The final 0.5.0 regression pass also fixed:

- Harness v2 smoke fixtures against Collaboration v1 Shared Contract / Plan Approval rules;
- Adaptive Agent Budget classification for explicit Explore and background Explore requests;
- Chinese `创建` write intent;
- `self-check` / `自检` / `复核` / `校验` verification intent;
- budget handling for explicit durable Remember / `记住` flows that invoke Curator.

### Windows release gate

The final candidate passed:

- `npm run test:desktop-background`
- `npm run test:collaboration`
- `npm run test:harness-v2`
- `npm run test:architecture`
- `npm run test:cache`
- `npm run test:runtime`
- `npm run build`
- Electron startup and manual Windows tray/background lifecycle checks

### Downloads

- **Setup**: `AporiaX-Setup-0.5.0-x64.exe`
- **Portable**: `AporiaX-Portable-0.5.0-x64.exe`
- **SHA256**: `SHA256SUMS.txt`

### Known boundaries

- Core HTTP `taskRpc` remains disabled; credentials, approvals, pause/resume, and mutation control stay in the desktop Runtime.
- Active tasks do not survive a full process exit/restart yet.
- Some legacy read-only subagent paths still use compatibility-runtime internals.
- Collaboration v1 intentionally does not provide unrestricted real-time peer-to-peer agent chat.

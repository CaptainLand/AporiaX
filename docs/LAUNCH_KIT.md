# AporiaX Launch Kit

Repository: https://github.com/CaptainLand/AporiaX

Latest release: https://github.com/CaptainLand/AporiaX/releases/latest

## Core positioning

**中文**

AporiaX 是一个本地优先的桌面 Agent，能写代码、制作 Word、PPT 与 Excel；每一次行动
都可见、可验证、可回退。

**English**

AporiaX is a local-first desktop agent for code and Office files, with visible,
reviewable, and reversible actions.

## 中文首发长文

### 标题

我做了一个本地优先的桌面 Agent：能写代码，也能生成 Word、PPT 和 Excel

### 正文

大家好，我是 SeaLandX。

过去一段时间我在做 AporiaX。它不是一个只输出聊天回复的助手，而是一个可以进入授权
工作区实际完成任务的桌面 Agent：读取与修改代码、运行命令、生成 Word、PPT、Excel，
并把修改、验证和产物留在界面里。

我最在意三个设计原则：

- **Route**：任务到底经过了哪些步骤，不藏在一句“已完成”背后。
- **Evidence**：调用了什么工具、改了哪些文件、如何验证，都能被检查。
- **Anchor**：重要修改留下快照，发现问题可以审核和回退。

AporiaX 支持多个 OpenAI-compatible API 与任务级模型选择。命令默认在本地临时工作区
副本中执行并进行冲突检查；Docker 是可选的加强隔离，而不是使用门槛。

现在仍是 Windows x64 Preview。我尤其想知道：

1. 初次配置 Provider 是否足够清楚？
2. Route、审核与回退是否真的让 Agent 更可信？
3. 代码与 Office 产物放在同一个 Agent 里，对你的工作是否有价值？

项目采用 MIT 协议，欢迎下载试用、提交 Issue，或者直接告诉我它哪里做得还不够好。

GitHub：https://github.com/CaptainLand/AporiaX

下载：https://github.com/CaptainLand/AporiaX/releases/latest

## 中文短文案

我做了一个本地优先的桌面 Agent：AporiaX。

它能写代码，也能生成 Word、PPT 和 Excel。Route 展示行动路径，Evidence 保留判断依据，
Anchor 让关键修改可以审核和回退。支持多个 OpenAI-compatible API，Docker 可选。

目前是 Windows Preview，想找第一批真实用户挑毛病：
https://github.com/CaptainLand/AporiaX

## Show HN

### Title

Show HN: AporiaX – A local-first desktop agent for code and Office files

### Post

Hi HN — I am SeaLandX, the author of AporiaX.

I built it because most desktop agents collapse a long task into a chat transcript.
That makes it difficult to answer basic questions: What is the agent doing? What did
it change? How was the result verified? Can I undo it safely?

AporiaX organizes work around three ideas:

- **Route** exposes the actual execution path.
- **Evidence** preserves tool calls, file changes, commands, and verification.
- **Anchor** creates checkpoints for review and rollback.

It works in a local workspace, edits code, runs commands, and creates real DOCX, PPTX,
and XLSX files. It supports multiple OpenAI-compatible providers and task-level model
selection. Docker is optional: the default local sandbox runs against a temporary
workspace copy and conflict-checks changes before syncing them back.

This is an MIT-licensed Windows preview. I would value feedback on the trust model,
first-run provider setup, and whether combining code and Office artifacts in one agent
is useful in practice.

Repo: https://github.com/CaptainLand/AporiaX

Release: https://github.com/CaptainLand/AporiaX/releases/latest

## Product Hunt

**Tagline**

Local-first agent for code, documents, slides, and spreadsheets.

**Short description**

AporiaX turns ambiguous requests into visible, reviewable, and reversible actions.
Work inside a local workspace, create code and Office files, inspect the execution
route, and roll back important changes.

**Maker comment**

I built AporiaX around a simple belief: an agent should not ask users to trust a final
answer without showing the path that produced it. Route, Evidence, and Anchor make the
work observable and reversible, while OpenAI-compatible providers keep model choice in
the user's hands. This preview is early, and I am looking for candid feedback from
people who use AI for both software and everyday knowledge work.

## English short post

I built AporiaX, an MIT-licensed local-first desktop agent for code and Office files.

It can edit a workspace, run commands, and create DOCX, PPTX, and XLSX files. Route
shows what happened, Evidence keeps the basis, and Anchor makes important changes
reviewable and reversible. Multiple OpenAI-compatible providers are supported.

Windows preview: https://github.com/CaptainLand/AporiaX

## Suggested screenshot order

1. Particle-ocean welcome screen — establish the AporiaX identity.
2. Dialogue — show a completed real task and mandatory self-check.
3. Route — show concrete file edits, commands, and timings.
4. About — close with Route, Evidence, and Anchor.

Avoid leading with Provider settings. Lead with a finished outcome and show configuration
only after the value is clear.

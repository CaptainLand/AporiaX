# AporiaX 本地 API、MCP 与 CLI

外部 Harness 可以把完整任务交给正在运行的 AporiaX，读取进度、追加要求、回答澄清、暂停/继续/取消，并领取持久化结果与产物。AporiaX 继续负责内部代理调度、执行权限、工作区和验证记录。

三种入口共用同一个任务服务：

- **MCP stdio**：面向支持 stdio MCP 的 Claude Code、Codex 及其他 Harness，桌面提供可复制配置。
- **HTTP API `/control/v1`**：面向自己的 Agent、脚本、自动化程序。
- **CLI**：与 MCP 一起分发，支持命令参数、JSON 文件和 JSON stdin。

当前只接入同一台电脑、同一操作系统用户下正在运行的 AporiaX。不需要 Cloud 远控，不需要公网端口。安装版随应用分发桥接程序，使用 AporiaX 自带的 Electron Node 运行时，无需另外安装 Node 或 npm 包。开发源码模式需要项目要求的 Node 版本。

## 1. 从桌面创建连接

1. 启动 AporiaX，确认已经配置可用的模型服务。
2. 点击顶栏 **外部连接**，打开外部连接开关。
3. 在 **授权工作区** 中点击 **选择目录并授权**。
4. 在 **创建连接** 中给 Harness 起一个名称，选择它可以使用的工作区、代理预设和模型服务。
5. 根据任务需要设置 **能力与运行限额**。命令、浏览器和指定 MCP 服务需要单独授权；只授予本次用途需要的能力。
6. 点击 **创建并获取连接配置**。复制 **MCP JSON** 或 **Codex TOML** 到调用方的 MCP 配置中，然后重新加载调用方的 MCP 服务。
7. 让调用方先使用 `aporiax_status` 和 `aporiax_list_workspaces` 检查连接。

每个 Harness 建议创建独立连接，便于区分任务归属、并发限制和撤销。凭据保存在 AporiaX 创建的私有 JSON 文件中；复制的 MCP 配置只包含文件路径。不要把私有连接文件加入 Git，也不要把 token 填进命令行参数或共享配置。

关闭某个 MCP/CLI 进程不会取消已经受理的任务。桌面 **撤销连接** 会停止该客户端的进行中任务，并使原凭据失效；已保存的任务结果仍保留给桌面用户。

## 2. MCP 配置

优先复制桌面实际生成的配置：安装位置、应用数据位置、当前操作系统的转义都会自动填写。

### 通用 / Claude 风格 JSON

下面的路径是示例，不能原样照抄。将 `aporiax` 项合并进调用方已有的 `mcpServers`，保留其他 MCP 服务。

```json
{
  "mcpServers": {
    "aporiax": {
      "command": "C:\\Program Files\\AporiaX\\AporiaX.exe",
      "args": [
        "C:\\Program Files\\AporiaX\\resources\\control-bridge.cjs",
        "mcp",
        "--connection",
        "C:\\Users\\Lan\\AppData\\Roaming\\AporiaX\\local-control\\connections\\CLIENT_ID.json"
      ],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1"
      }
    }
  }
}
```

### Codex 风格 TOML

```toml
[mcp_servers.aporiax]
command = "C:\\Program Files\\AporiaX\\AporiaX.exe"
args = ["C:\\Program Files\\AporiaX\\resources\\control-bridge.cjs", "mcp", "--connection", "C:\\Users\\Lan\\AppData\\Roaming\\AporiaX\\local-control\\connections\\CLIENT_ID.json"]

[mcp_servers.aporiax.env]
ELECTRON_RUN_AS_NODE = "1"
```

这是常见客户端格式的配置模板。实际客户端版本、配置所在文件及是否自动加载 MCP，以该客户端的设置为准。本仓库测试使用官方 MCP SDK 的 Client/Server 和真实 stdio 传输，没有把模板生成测试等同于所有客户端 UI 的兼容性认证。

### 源码开发模式

安装依赖后可以直接运行桥接源码：

```bash
node electron/control/bridge/entry.js mcp --connection /absolute/path/to/client.json
```

配置到调用方时，`command` 使用 Node 的绝对路径，`args` 使用 `entry.js` 的绝对路径及同样的 `mcp --connection ...` 参数；不需要 `ELECTRON_RUN_AS_NODE`。AporiaX 桌面仍须另外启动。

安装路径移动后应重新复制配置。便携版的解包目录可能随启动改变；优先使用安装版的稳定路径，不要将一次运行中的临时解包路径当作永久启动器。

## 3. 给其他 Harness 的使用说明

可以将下面这段加入调用方的工作说明：

> 需要使用 AporiaX 时，先调用 aporiax_status、aporiax_list_workspaces、aporiax_list_profiles、aporiax_list_providers。选择已授权工作区和预设，通过 aporiax_start_run 委派完整任务。每个逻辑任务使用独立且稳定的 idempotency_key；响应丢失后用同一个键和同一份请求重试。保存 run_id，以 aporiax_get_run 和 aporiax_read_events 查询进度，事件游标使用服务端返回的 next_seq。遇到业务问题可以 answer_question，权限审批交给用户在桌面处理。结束后读取 get_result，区分 completed、partial、blocked、failed、interrupted、cancelled，并查看验证状态；不要把任务结束等同于验证成功。产物内容使用 list_artifacts/read_artifact 获取。需要停止任务时明确调用 cancel_run，关闭 MCP 不会取消任务。

调用顺序示例：

```json
{
  "name": "aporiax_start_run",
  "arguments": {
    "workspace_id": "ws_FROM_LIST_WORKSPACES",
    "profile": "review",
    "instruction": "检查鉴权与计费请求链路，给出带源码位置的发现、风险和建议，不修改代码。",
    "idempotency_key": "review-auth-20260928-01",
    "limits": {
      "max_duration_seconds": 900,
      "max_model_calls": 40,
      "max_tool_calls": 200,
      "max_parallel_agents": 2,
      "max_subagents": 4
    }
  }
}
```

数字仅为示例，不能超过创建连接时用户授予的上限。创建立即返回 `run_id`，任务可能先进入 `queued`。调用方可每 2–5 秒查询一次；收到 `429` 时退避，避免用高频轮询占满本地接口。

`aporiax_list_agents` 可以观察任务内部的主代理和子代理。当前通过所属 run 进行调度、指导和中断，未提供任意改写内部代理状态、越过主代理直接接管子代理的接口。

### MCP 工具清单

| 工具 | 作用 |
| --- | --- |
| `aporiax_status` | 桌面连接状态、API 版本和客户端权限 |
| `aporiax_list_workspaces` | 已授权的工作区 |
| `aporiax_list_profiles` | 已授权代理预设 |
| `aporiax_list_providers` | 已授权模型服务与模型，不返回凭据 |
| `aporiax_list_runs` | 当前客户端的任务列表及分页 |
| `aporiax_start_run` | 创建后台任务，幂等重试 |
| `aporiax_get_run` | 状态、执行工作区与运行信息 |
| `aporiax_get_result` | 持久结果、验证信息和产物索引 |
| `aporiax_read_events` | 按持久游标读取有序事件 |
| `aporiax_list_agents` | 任务内部代理状态 |
| `aporiax_list_questions` | 待回答的业务澄清 |
| `aporiax_list_approvals` | 待用户处理的审批，只读 |
| `aporiax_list_artifacts` | 可读取的产物索引 |
| `aporiax_send_message` | 给所属任务追加指导 |
| `aporiax_answer_question` | 回答业务澄清 |
| `aporiax_pause_run` | 请求暂停 |
| `aporiax_resume_run` | 继续当前可恢复的暂停任务 |
| `aporiax_cancel_run` | 明确请求取消 |
| `aporiax_read_artifact` | 以精确字节分页读取产物 |

## 4. CLI

源码模式的所有命令使用相同入口：

```bash
node electron/control/bridge/entry.js help
node electron/control/bridge/entry.js status --connection /absolute/path/to/client.json
node electron/control/bridge/entry.js workspaces --connection /absolute/path/to/client.json
node electron/control/bridge/entry.js profiles --connection /absolute/path/to/client.json
node electron/control/bridge/entry.js providers --connection /absolute/path/to/client.json
node electron/control/bridge/entry.js openapi --connection /absolute/path/to/client.json
```

Windows 安装版在 PowerShell 中使用桌面给出的实际路径：

```powershell
$aporiaExe = 'C:\Program Files\AporiaX\AporiaX.exe'
$aporiaBridge = 'C:\Program Files\AporiaX\resources\control-bridge.cjs'
$aporiaConnection = 'C:\Users\Lan\AppData\Roaming\AporiaX\local-control\connections\CLIENT_ID.json'
$env:ELECTRON_RUN_AS_NODE = '1'
& $aporiaExe $aporiaBridge status --connection $aporiaConnection
& $aporiaExe $aporiaBridge workspaces --connection $aporiaConnection
```

任务参数可写入 `request.json`，内容与 `aporiax_start_run.arguments` 相同：

```bash
node electron/control/bridge/entry.js run --connection /absolute/path/to/client.json --input request.json
cat request.json | node electron/control/bridge/entry.js run --connection /absolute/path/to/client.json --input -
```

也可以使用具名参数：

```bash
node electron/control/bridge/entry.js run --connection /absolute/path/to/client.json --workspace ws_ID --profile review --instruction "检查项目并输出审查报告" --request-id review-project-001 --max-subagents 0
```

后续操作示例：

```bash
node electron/control/bridge/entry.js runs --connection /absolute/path/to/client.json --limit 20
node electron/control/bridge/entry.js get RUN_ID --connection /absolute/path/to/client.json
node electron/control/bridge/entry.js events RUN_ID --connection /absolute/path/to/client.json --after-seq 0 --limit 100
node electron/control/bridge/entry.js message RUN_ID --connection /absolute/path/to/client.json --content "补充检查请求超时情况"
node electron/control/bridge/entry.js questions RUN_ID --connection /absolute/path/to/client.json
node electron/control/bridge/entry.js answer RUN_ID QUESTION_ID --connection /absolute/path/to/client.json --answer "输出 Markdown"
node electron/control/bridge/entry.js pause RUN_ID --connection /absolute/path/to/client.json
node electron/control/bridge/entry.js resume RUN_ID --connection /absolute/path/to/client.json
node electron/control/bridge/entry.js cancel RUN_ID --connection /absolute/path/to/client.json
node electron/control/bridge/entry.js result RUN_ID --connection /absolute/path/to/client.json
node electron/control/bridge/entry.js artifacts RUN_ID --connection /absolute/path/to/client.json
node electron/control/bridge/entry.js artifact RUN_ID ARTIFACT_ID --connection /absolute/path/to/client.json --offset 0 --limit 65536
```

所有 API 命令都接受 `--input FILE`、`--input -` 或 `--json '{...}'`。JSON 字段使用 snake_case，与 MCP 一致。不能同时从 JSON 和命令参数重复指定同一个字段。

成功时 stdout 是单个 JSON 响应；失败时 stdout 为空，stderr 为错误 JSON，进程以非零状态退出。MCP 模式的 stdout 仅承载协议消息，日志只写 stderr。

## 5. HTTP API 契约

### 连接发现与认证

客户端连接文件形状：

```json
{
  "version": 1,
  "clientId": "CLIENT_ID",
  "token": "PRIVATE_CLIENT_BEARER_TOKEN",
  "discoveryPath": "ABSOLUTE_PATH_TO_DISCOVERY_JSON"
}
```

其中 token 是示例占位符。真实文件由桌面创建并保护，POSIX 使用私有权限，Windows 使用用户私有 ACL。发现文件中没有 token：

```json
{
  "version": 1,
  "baseUrl": "http://127.0.0.1:RANDOM_PORT",
  "apiPath": "/control/v1",
  "instanceId": "DESKTOP_INSTANCE_ID",
  "enabled": true
}
```

**每次请求重新读取 discovery**。桌面重启会换端口，不能把创建连接时显示的端口永久写死。凭据在有效期内可继续使用，撤销后必须新建连接。

请求通过 `Authorization: Bearer ...` 认证；POST 必须设置 `Content-Type: application/json`，即使请求体是 `{}`。服务只监听 `127.0.0.1`，校验精确的数字 loopback Host，拒绝浏览器 Origin。直接 API 客户端应禁止重定向并设置超时，不应把浏览器网页作为本地控制客户端。

`GET /control/v1/openapi` 返回需认证的 OpenAPI 3.1 文档，`/meta` 同时提供 `openapi_path`。自己的 Harness 可以用它读取请求、响应及错误 schema，无需从界面反推。默认限速为每客户端每分钟 240 次、通过 Host/Origin 检查的全部请求每分钟 2400 次，无效认证请求另有每分钟 240 次限制。429 响应带 `Retry-After: 60`，`error.details.scope` 标明 `global`、`client` 或 `unauthenticated`。CLI `openapi` 可直接导出 schema。

### 路由

下表所有路径均相对 `/control/v1`。请求 JSON 和响应字段使用 snake_case。

| 方法与路径 | 输入 / 返回 |
| --- | --- |
| `GET /meta` | `api_version`、客户端、能力、限额 |
| `GET /openapi` | 已认证的 OpenAPI 3.1 路由、参数、请求和响应 schema |
| `GET /workspaces` | `{workspaces: [...]}` |
| `GET /profiles` | `{profiles: [...]}` |
| `GET /providers` | `{providers: [...]}` |
| `GET /runs?limit=100&before=RUN_ID` | `{runs, next_before, has_more}`；limit 1–200 |
| `POST /runs` | `{instruction, workspace_id, profile, idempotency_key, provider_id?, model_id?, limits?}` → HTTP 202，含 `run_id` |
| `GET /runs/:run_id` | 当前持久任务状态 |
| `GET /runs/:run_id/result` | `{run_id, status, result, artifacts}` |
| `GET /runs/:run_id/events?after_seq=0&limit=200` | `{events, next_seq, has_more}`；limit 1–1000 |
| `GET /runs/:run_id/agents` | `{agents: [...]}` |
| `GET /runs/:run_id/questions` | `{questions: [...]}` |
| `GET /runs/:run_id/approvals` | `{approvals: [...]}`，只读 |
| `GET /runs/:run_id/artifacts` | `{artifacts: [...]}` |
| `POST /runs/:run_id/messages` | `{content}` |
| `POST /runs/:run_id/questions/:question_id/answer` | `{answer: "业务问题的回答"}` |
| `POST /runs/:run_id/pause` | `{}` |
| `POST /runs/:run_id/resume` | `{}` |
| `POST /runs/:run_id/cancel` | `{}` |
| `GET /runs/:run_id/artifacts/:artifact_id?offset=0&limit=65536` | 精确字节分页，limit 1–65536 |

创建任务的 `instruction` 最多 60,000 字符，追加消息同样最多 60,000 字符，澄清答案最多 4,000 字符，且 HTTP JSON 请求体总计不超过 128 KiB。`idempotency_key` 最多 160 字符，仅允许字母、数字、下划线、短横线、冒号、点。键按客户端隔离；相同键与相同请求返回已有任务，相同键与不同内容返回 409。

任务仍在执行且尚未保存交付时，结果接口返回 `result: null`；此时应继续查看 `status` 和事件，不能把空结果解释为已成功完成。

`profile` 可选 `review` 或 `workspace`。客户端必须已经获得对应预设及工作区授权。`provider_id` / `model_id` 可省略，由已授权服务选择默认值；接口不接受调用方提交模型密钥、任意系统提示或完整桌面配置来绕过授权。

`limits` 支持：

| 字段 | 单位 | 全局最大值 |
| --- | --- | --- |
| `max_duration_seconds` | 秒 | 86400 |
| `max_model_calls` | 模型调用次数 | 2000 |
| `max_tool_calls` | 工具调用次数 | 10000 |
| `max_parallel_agents` | 并行代理数 | 8 |
| `max_subagents` | 子代理总数 | 100 |

实际值还受用户为客户端配置的更小上限约束，超出上限会拒绝。除任务时长外，计数限制允许 0，表示禁用对应调用或委派能力。预算涵盖受本次任务调度的子代理；这些是运行量限制，不是货币费用报价。模型调用使用 AporiaX 配置的 Cloud、BYOK 或本地模型，外部 Harness 的订阅额度不会转移进来。

### 产物读取

产物接口只能读取当前客户端有权访问的任务所登记的产物 ID，不接受任意文件路径。分页返回：

```json
{
  "artifact_id": "ARTIFACT_ID",
  "name": "answer.md",
  "mime_type": "text/markdown",
  "encoding": "base64",
  "content": "BASE64_OF_THIS_PAGE",
  "offset": 0,
  "next_offset": 65536,
  "total_bytes": 100000,
  "has_more": true
}
```

每页将 `content` 以 base64 解码为字节，按 offset 顺序拼接，直到 `has_more: false`。拼接完成后再按 UTF-8 解码文本；不能把可能切开中文字符的单页字节分别解码再拼接字符串。CLI 为保持原始数据，输出同样的 base64 JSON。

产物若在登记后发生变化会明确报错，避免把未验证的新文件冒充原成果。工作区编辑运行产生的文件、补丁和修改说明应由调用方或用户检查后合并。

### 错误

```json
{
  "error": {
    "code": "scope_denied",
    "message": "This workspace or profile was not granted to the client."
  }
}
```

| 错误 / 状态 | 处理方式 |
| --- | --- |
| `DESKTOP_UNAVAILABLE` | 启动桌面，检查外部连接开关后重试；已受理任务不会因此自动取消 |
| `CONNECTION_NOT_FOUND` | 重新复制桌面生成的连接配置，确认路径属于当前用户 |
| `CONTROL_DISABLED` / HTTP 503 | 在桌面启用外部连接 |
| `API_VERSION_MISMATCH` | 更新桌面/桥接程序并重新生成配置 |
| `INSECURE_CONNECTION` | POSIX 私有连接文件权限改为 600；确认是同一系统用户 |
| HTTP 401 | 客户端凭据无效或已撤销，新建连接 |
| HTTP 403 / `scope_denied` | 调整任务到既有授权范围；需要扩大权限时由用户在桌面配置 |
| HTTP 403 / `human_approval_required` | 审批由用户在 AporiaX 桌面完成，外部 Agent 无法代批 |
| HTTP 404 / `run_not_found` | ID 不存在或不属于此客户端，不代表能枚举其他人的任务 |
| HTTP 409 / `idempotency_conflict` | 同一逻辑任务保留原请求；新逻辑任务使用新键 |
| HTTP 409 / 任务尚未准备好 | 查询任务状态后再发送操作 |
| HTTP 413 | 缩小请求、结果或事件分页 |
| HTTP 429 | 降低轮询频率并退避重试 |
| `API_TIMEOUT` | 创建请求结果可能不确定；先查询，或用相同幂等键重试，避免重复任务 |

## 6. 生命周期与权限边界

- 运行状态和事件、结果存入 SQLite。事件按持久序号分页，不依赖桌面内存中的最近事件窗口。
- 外部连接只能读取和操作自己创建的任务。已有普通桌面对话不会自动对外开放。
- 用户在 **外部连接** 面板可以观察外部任务、发送指导、回答澄清和处理审批。
- 暂停/取消是运行时请求，可能要等到工具或模型调用的中断边界。已经写入的文件或已发生的外部操作不会被“取消”自动撤销。
- 桌面关闭/异常退出后，未完成的任务会保留为中断结果；重启不会静默重放有副作用的任务。完成结果可以在重启后读取。需要继续时检查结果并显式创建后续任务。
- `workspace` 任务在独立执行工作区中编辑，交付补丁/产物，源目录不自动回写。外部 Harness 与 AporiaX 不应直接同时修改同一个目录。
- 权限取用户规则、客户端授权、任务限额和代理角色的交集。回答业务问题不能替代工具审批，也不能扩大工作区、命令、浏览器或 MCP 权限。
- MCP 回调和递归委派受服务白名单和任务预算限制。不要给 AporiaX 再配置一个无限回调自身的控制链。
- 本地控制授权不是独立的 OS 安全沙箱。命令、浏览器、第三方 MCP 等能力具有各自的实际执行边界；只向可信的本机 Harness 授权。

## 7. 构建与验证

```bash
node scripts/build-control-bridge.mjs
node --experimental-sqlite tests/local-control-mcp.mjs
node --experimental-sqlite tests/local-control-http.mjs
node --experimental-sqlite tests/local-control-service.mjs
```

构建将现有 `@modelcontextprotocol/sdk` 与桥接源码打包进 `build/control-bridge.cjs`，由发布配置复制进安装包 resources。生成文件不进入 Git。

`local-control-mcp.mjs` 通过官方 SDK Client 启动实际 stdio Server，覆盖工具发现、JSON 输入校验、任务幂等、断连不取消、端口变化、鉴权失败、私有文件/loopback 检查、base64 中文分页、CLI 和打包产物。构建产物复制到项目之外测试，另使用 `ELECTRON_RUN_AS_NODE=1` 和真实 Electron 可执行文件完成 stdio 握手及 API 调用，验证不依赖外部 Node 命令。它还连接生产版 Control Service / HTTP Server / SQLite，验证任务创建、事件、指导、澄清、持久结果、产物以及服务重启后读取。

测试中的模型执行回调是受控模拟。真实模型长任务、Windows 安装版和指定外部 Harness 的 UI 联调仍需要在对应环境验收；这些结果不会由协议测试自动推导出来。

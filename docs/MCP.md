# AporiaX MCP v1

AporiaX can connect user-trusted Model Context Protocol servers and adapt their tools, resources, and prompts into the Harness runtime.

## Architecture

```text
User task
   ↓
AporiaX Harness
   ↓
MCP Runtime (per run)
   ├─ stdio server
   └─ Streamable HTTP server
          ↓
     discover capabilities
          ↓
   namespaced MCP tools
          ↓
 Harness approval + Route + Witness
```

MCP does not bypass the AporiaX permission model. Server content is external/untrusted data, not higher-priority Agent instructions.

## Why server commands are user-level only

A repository is untrusted input. AporiaX therefore does **not** allow a project to define an arbitrary MCP `command`.

User-trusted server definitions live in:

```text
<Electron userData>/aporiax-mcp.json
```

A project may only select or disable IDs that already exist in that user-level file:

```text
<workspace>/.aporiax/mcp.json
```

This prevents opening a repository from silently turning an `.aporiax` file into process execution.

## User configuration

### stdio

```json
{
  "servers": [
    {
      "id": "local-tools",
      "name": "Local Tools",
      "transport": "stdio",
      "command": "node",
      "args": ["D:/mcp/local-tools/server.mjs"],
      "env": {
        "SERVICE_TOKEN": "${SERVICE_TOKEN}"
      },
      "autoApproveReadOnly": false,
      "timeoutMs": 30000
    }
  ]
}
```

### Streamable HTTP

```json
{
  "servers": [
    {
      "id": "remote-tools",
      "name": "Remote Tools",
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${REMOTE_MCP_TOKEN}"
      },
      "autoApproveReadOnly": false
    }
  ]
}
```

`${ENV_VAR}` references are resolved from the AporiaX process environment. Keep secrets out of project files and source control.

MCP v1 supports stdio and modern Streamable HTTP. Legacy HTTP+SSE is intentionally not enabled by default.

## Project selection

To opt a workspace into only some user-trusted servers:

```json
{
  "servers": ["remote-tools", "local-tools"]
}
```

To disable selected servers for one workspace:

```json
{
  "disabled": ["remote-tools"]
}
```

If `servers` is omitted or empty, all enabled user-level servers are eligible except IDs listed under `disabled`.

Project MCP configuration cannot define `command`, `args`, `env`, URL credentials, or new server IDs.

## Tool names

Remote tools are adapted to OpenAI-compatible function-calling names:

```text
mcp__<server-id>__<remote-tool-name>
```

Unsafe characters are normalized and long names receive a stable hash suffix so they stay within the function-name limit.

The Agent receives the remote tool's JSON input schema as its function `parameters`.

## Resources and prompts

When connected servers advertise resources/prompts, AporiaX adds four read helpers:

```text
mcp_list_resources
mcp_read_resource
mcp_list_prompts
mcp_get_prompt
```

Resource blobs and image/audio payloads are not dumped into the model context as raw base64. Text is bounded and binary payloads are represented as metadata.

## Approval policy

MCP tool annotations are useful hints but not trusted authority.

- side-effecting or unknown MCP tools require explicit approval
- a server tool marked `readOnlyHint: true` still requires approval by default
- the user may opt a trusted server into `autoApproveReadOnly: true`
- `read-only` AporiaX tasks expose only MCP tools whose server declares `readOnlyHint: true`
- Builder workers do not receive MCP tools
- project configuration cannot enable read-only auto approval

This keeps MCP aligned with the existing AporiaX approval boundary.

## Per-run lifecycle

MCP connections are created for a Harness run and closed when that run completes, fails, or is interrupted.

During discovery AporiaX records server connection events and tool/resource/prompt counts. MCP tool calls also emit Harness events and ordinary tool activity so Route/Witness can observe them.

## Current v1 boundaries

Not yet included:

- in-app MCP server editor
- OAuth authorization-code UI for remote servers
- legacy SSE fallback
- persistent cross-run MCP connections
- MCP sampling/elicitation/tasks
- server-pushed resource subscriptions
- marketplace/one-click server install

The first release focuses on a small, reviewable host surface: connect, discover, call tools, read resources, and get prompts.

## Validation

```bash
npm install
npm run test:mcp
npm run test:architecture
npm run build
npm start
```

Then create a user-level `aporiax-mcp.json`, restart AporiaX, and run a task that clearly requires the configured MCP server. Use the task's Route/Witness view to confirm connection and tool activity.

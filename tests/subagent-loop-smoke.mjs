import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, createPermissionPolicy } from "../electron/agent-core.js";
import { runSubagentTask } from "../electron/runtime/subagent-loop.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "aporiax-subagent-loop-"));
try {
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "a.js"), "export const a = 1;\n", "utf8");

  const registry = new ToolRegistry([
    {
      risk: "read",
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "Read file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    },
  ]);
  let round = 0;
  const provider = {
    supportsTools: true,
    supportsThinking: false,
    thinkingMode: "none",
    async complete() {
      round += 1;
      if (round === 1) {
        return {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-read",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "src/a.js" }),
                },
              },
            ],
          },
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        };
      }
      return {
        message: { content: "Verified src/a.js." },
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      };
    },
  };
  const events = [];
  const result = await runSubagentTask({
    agentId: "subagent-1",
    input: {
      role: "review",
      task: "Review src/a.js",
      scope: ["src"],
      background: false,
      maxRounds: 4,
    },
    provider,
    modelId: "fake-model",
    modelConfig: { contextWindow: 128_000 },
    thinking: false,
    effort: "high",
    workspaceRoot,
    parentPermissionPolicy: createPermissionPolicy("workspace-write"),
    approvalMode: "sandbox-auto",
    requestApproval: async () => ({ approved: true }),
    signal: new AbortController().signal,
    sandboxExecutor: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    sandboxStatus: { localAvailable: true, autoApprovalSafe: true },
    language: "en",
    memoryFacts: [],
    emit: (event) => events.push(event),
    toolRegistry: registry,
    parseToolArguments: (toolCall) => JSON.parse(toolCall.function.arguments || "{}"),
    describeToolActivity: (toolCall) => ({
      path: JSON.parse(toolCall.function.arguments || "{}").path || "",
    }),
    executeAuthorizedTool: async ({ toolName, input }) => {
      assert.equal(toolName, "read_file");
      assert.equal(input.path, "src/a.js");
      return {
        modelResult: {
          path: input.path,
          content: "export const a = 1;\n",
        },
      };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.summary, "Verified src/a.js.");
  assert.equal(result.rounds, 2);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].tool, "read_file");
  assert.equal(result.evidence[0].path, "src/a.js");
  assert(events.some((event) => event.type === "subagent.started"));
  assert(events.some((event) => event.type === "subagent.tool.started"));
  assert(events.some((event) => event.type === "subagent.tool.completed"));
  assert(events.some((event) => event.type === "subagent.completed"));
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}

console.log("subagent loop smoke: PASS");

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

// End-to-end orchestration smoke: a large task may spend one planner call, run
// two isolated Builders, merge both scopes, and then hand the integrated
// workspace back to the Lead/Main agent. This uses a deterministic mock
// provider so no network or paid model request is involved.
function createSseResponse(delta) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

function toolDelta(id, name, input) {
  return {
    tool_calls: [
      {
        index: 0,
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      },
    ],
  };
}

function toolCallsDelta(calls) {
  return {
    tool_calls: calls.map((call, index) => ({
      index,
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.input),
      },
    })),
  };
}

const orchestrationRepo = await mkdtemp(
  join(tmpdir(), "aporiax-builder-orchestration-smoke-"),
);
const originalFetch = globalThis.fetch;
try {
  git(orchestrationRepo, ["init"]);
  git(orchestrationRepo, ["config", "user.email", "aporiax-smoke@example.invalid"]);
  git(orchestrationRepo, ["config", "user.name", "AporiaX Smoke"]);
  await mkdir(join(orchestrationRepo, "src", "auth"), { recursive: true });
  await mkdir(join(orchestrationRepo, "src", "ui"), { recursive: true });
  await writeFile(
    join(orchestrationRepo, "src", "auth", "auth.js"),
    "export const authVersion = 1;\n",
    "utf8",
  );
  await writeFile(
    join(orchestrationRepo, "src", "ui", "ui.js"),
    "export const uiVersion = 1;\n",
    "utf8",
  );
  git(orchestrationRepo, ["add", "."]);
  git(orchestrationRepo, ["commit", "-m", "baseline"]);

  const modelProvider = {
    id: "orchestration-smoke",
    name: "Orchestration Smoke",
    vendor: "deepseek",
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-only",
    models: [
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        contextWindow: 1_000_000,
        supportsTools: true,
        supportsThinking: false,
        thinkingMode: "none",
      },
    ],
  };
  const requestText = (body) =>
    (body.messages || [])
      .map((message) =>
        typeof message.content === "string" ? message.content : "",
      )
      .join("\n");
  const toolText = (body) =>
    (body.messages || [])
      .filter((message) => message.role === "tool")
      .map((message) => String(message.content || ""))
      .join("\n");

  const builderRounds = { auth: 0, ui: 0 };
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const text = requestText(body);
    const tools = toolText(body);

    if (text.includes("AporiaX Harness orchestration preflight.")) {
      return createSseResponse({
        content: JSON.stringify({
          parallelize: true,
          reason: "auth and ui are independent write scopes",
          tasks: [
            {
              id: "auth",
              title: "Upgrade auth",
              task: "Update src/auth/auth.js to authVersion 2.",
              writeScopes: ["src/auth"],
              dependsOn: [],
            },
            {
              id: "ui",
              title: "Upgrade ui",
              task: "Update src/ui/ui.js to uiVersion 2.",
              writeScopes: ["src/ui"],
              dependsOn: [],
            },
          ],
        }),
      });
    }

    const builderMatch = text.match(/AporiaX Builder worker \((auth|ui)\)/);
    if (builderMatch) {
      const role = builderMatch[1];
      const path = role === "auth" ? "src/auth/auth.js" : "src/ui/ui.js";
      const content =
        role === "auth"
          ? "export const authVersion = 2;\n"
          : "export const uiVersion = 2;\n";
      builderRounds[role] += 1;
      if (builderRounds[role] === 1) {
        return createSseResponse(
          toolDelta(`${role}-write`, "write_file", { path, content }),
        );
      }
      if (builderRounds[role] === 2) {
        return createSseResponse(
          toolDelta(`${role}-self-check-start`, "complete_self_check", {
            summary: `${role} initial check request.`,
            checks: ["request self-check"],
            improvements: [],
            remaining_risks: [],
          }),
        );
      }
      if (builderRounds[role] === 3) {
        return createSseResponse(
          toolDelta(`${role}-read`, "read_file", { path }),
        );
      }
      if (builderRounds[role] === 4) {
        return createSseResponse(
          toolDelta(`${role}-self-check`, "complete_self_check", {
            summary: `${role} scoped implementation checked.`,
            checks: ["latest scoped file re-read"],
            improvements: [],
            remaining_risks: [],
          }),
        );
      }
      return createSseResponse({ content: `${role} Builder completed.` });
    }

    if (text.includes("AporiaX Harness orchestration update for the Lead/Main agent.")) {
      const hasIntegratedRead =
        tools.includes('"path":"src/auth/auth.js"') &&
        tools.includes('"path":"src/ui/ui.js"') &&
        tools.includes('"content"');
      if (!hasIntegratedRead) {
        return createSseResponse(
          toolCallsDelta([
            {
              id: "lead-read-auth",
              name: "read_file",
              input: { path: "src/auth/auth.js" },
            },
            {
              id: "lead-read-ui",
              name: "read_file",
              input: { path: "src/ui/ui.js" },
            },
          ]),
        );
      }
      return createSseResponse({ content: "Lead verified and integrated both Builder changes." });
    }

    throw new Error(`Unexpected orchestration model request: ${text.slice(-400)}`);
  };

  const orchestrationEvents = [];
  const { runHarness } = await import("../electron/agent-runtime.js");
  const orchestrated = await runHarness({
    runId: "builder-orchestration-smoke",
    taskId: "builder-orchestration-smoke-task",
    provider: modelProvider,
    workspacePath: orchestrationRepo,
    modelId: "deepseek-v4-pro",
    thinking: false,
    effort: "high",
    permission: "workspace-write",
    approvalMode: "manual",
    language: "en",
    messages: [
      {
        role: "user",
        content:
          "Large multi-module architecture refactor: use parallel Builder agents to upgrade src/auth and src/ui independently, with scheduler and worktree isolation, then verify the integrated result.",
      },
    ],
    sandboxStatusResolver: async () => ({
      state: "unavailable",
      available: false,
      localAvailable: false,
      autoApprovalSafe: false,
      detail: "No commands are needed in this smoke test.",
    }),
    requestApproval: async () => ({ approved: false }),
    onEvent: (event) => orchestrationEvents.push(event),
  });
  assert.equal(orchestrated.status, "completed");
  assert.equal(orchestrated.orchestration?.enabled, true);
  assert.equal(orchestrated.orchestration?.builders.length, 2);
  assert.equal(
    orchestrated.orchestration.builders.every(
      (builder) => builder.status === "completed",
    ),
    true,
  );
  assert.deepEqual(
    orchestrated.changes.map((change) => change.path).sort(),
    ["src/auth/auth.js", "src/ui/ui.js"],
  );
  assert.equal(
    await readFile(join(orchestrationRepo, "src", "auth", "auth.js"), "utf8"),
    "export const authVersion = 2;\n",
  );
  assert.equal(
    await readFile(join(orchestrationRepo, "src", "ui", "ui.js"), "utf8"),
    "export const uiVersion = 2;\n",
  );
  assert.equal(
    orchestrationEvents.filter(
      (event) => event.type === "subagent.started" && event.role === "builder",
    ).length,
    2,
  );
  assert.equal(
    orchestrationEvents.some((event) => event.type === "task_graph.completed"),
    true,
  );
} finally {
  globalThis.fetch = originalFetch;
  await rm(orchestrationRepo, { recursive: true, force: true });
}

console.log("harness v2 orchestration smoke: PASS");
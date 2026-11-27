import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runHarness } from "../electron/agent-runtime-core.js";

const originalFetch = globalThis.fetch;
let calls = 0;
try {
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    const instructions = body.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    if (calls === 1) {
      assert.doesNotMatch(instructions, /local-only|Expanded reply is optional/);
      return new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'discover',type:'function',function:{
        name:'enable_task_tools',arguments:'{"groups":["planning","delivery"]}',
      }}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
    }
    assert.match(instructions, /HTML path to open it in the browser/);
    assert.match(instructions, /Markdown path to open its reading view/);
    assert.match(instructions, /Do not auto-open source files/);
    assert.match(instructions, /does not verify interactions/);
    assert.match(instructions, /local-only/);
    assert.match(instructions, /whether the service remains available/);
    assert.match(instructions, /brief progress updates during substantial work/);
    assert.match(instructions, /Result-first delivery:/);
    assert.match(instructions, /Do not organize the final answer as explore\/review\/verify sections/);
    assert.match(instructions, /certification, parent-reviewed-not-independent-proof/);
    assert.match(instructions, /Never put an important failure or action only in the full reply/);
    assert.match(instructions, /speak naturally to the user, not like an audit report/);
    assert.match(instructions, /at most one or two genuinely important points/);
    assert.match(instructions, /a build or syntax check alone does not prove browser\/runtime behavior/);
    assert.match(instructions, /Expanded reply is optional/);
    assert.match(instructions, /Do not use Verification note/);
    assert.match(instructions, /Do not append generic saved-but-not-tested or review-pending disclaimers/);
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: "Hello, what would you like to do?" } }] }) + '\n\ndata: [DONE]\n\n');
  };
  const result = await runHarness({
    runId: "delivery-guidance", taskId: "test", workspacePath: fileURLToPath(new URL(".", import.meta.url)), permission: "read-only", thinking: false,
    provider: { id: "test", name: "test", vendor: "openai", apiKey: "test-only", baseUrl: "https://test.invalid/v1", models: [{ id: "test", supportsTools: true, supportsThinking: false }] },
    modelId: "test", language: "en", messages: [{ role: "user", content: "Inspect the workspace and report verified file and preview links." }],
  });
  assert.equal(result.status, "completed");
  assert.equal(result.content, "Hello, what would you like to do?");
  assert.equal(calls, 2, "one batched discovery, then delivery without extra review");
  console.log("Delivery guidance: file/preview links, concise success only, caveats retained, ordinary conversation unchanged: PASS");
} finally { globalThis.fetch = originalFetch; }

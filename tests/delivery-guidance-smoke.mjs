import assert from "node:assert/strict";
import { runHarness } from "../electron/agent-runtime-core.js";

const originalFetch = globalThis.fetch;
let calls = 0;
try {
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    const instructions = body.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    assert.match(instructions, /Completion handoff only:/);
    assert.match(instructions, /clickable links to the actual deliverable files/);
    assert.match(instructions, /Preview handoff only:/);
    assert.match(instructions, /local-only/);
    assert.match(instructions, /whether the service will remain running/);
    assert.match(instructions, /do not shorten in-progress milestone updates/);
    assert.match(instructions, /Never remove an important failure or unverified limitation/);
    assert.match(instructions, /Result-first delivery:/);
    assert.match(instructions, /Do not organize the final answer as explore\/review\/verify sections/);
    assert.match(instructions, /certification, parent-reviewed-not-independent-proof/);
    assert.match(instructions, /Never put an important failure or action only in the full reply/);
    assert.match(instructions, /speak naturally to the user, not like an audit report/);
    assert.match(instructions, /at most one or two genuinely important points/);
    assert.match(instructions, /a build or syntax check alone does not prove browser\/runtime behavior/);
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: "Hello, what would you like to do?" } }] }) + '\n\ndata: [DONE]\n\n');
  };
  const result = await runHarness({
    runId: "delivery-guidance", taskId: "test", workspacePath: "", permission: "read-only", thinking: false,
    provider: { id: "test", name: "test", vendor: "openai", apiKey: "test-only", baseUrl: "https://test.invalid/v1", models: [{ id: "test", supportsTools: true, supportsThinking: false }] },
    modelId: "test", language: "en", messages: [{ role: "user", content: "Hello" }],
  });
  assert.equal(result.status, "completed");
  assert.equal(result.content, "Hello, what would you like to do?");
  assert.equal(calls, 1, "handoff guidance adds no extra model call");
  console.log("Delivery guidance: file/preview links, concise success only, caveats retained, ordinary conversation unchanged: PASS");
} finally { globalThis.fetch = originalFetch; }

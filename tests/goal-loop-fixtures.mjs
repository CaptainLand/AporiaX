// Deterministic test helpers. All remote providers are mocked .invalid endpoints.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
export function suite(name) {
  const results = [];
  return {
    async test(title, run) {
      const start = performance.now();
      try { const measurements = await run(); results.push({ name: title, passed: true, durationMs: Math.round(performance.now() - start), ...(measurements ? { measurements } : {}) }); console.log("PASS", title); }
      catch (error) { results.push({ name: title, passed: false, error: error.stack }); console.error("FAIL", title, error); }
    },
    async finish() {
      await mkdir(".tmp/audit-results", { recursive: true });
      await writeFile(`.tmp/audit-results/${name}.json`, JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2));
      console.log(`${name}: ${results.filter((r) => r.passed).length}/${results.length} cases passed`);
      assert(results.length && results.every((r) => r.passed), `${name} had failures`);
    },
  };
}
export const provider = { id: "goal-fixture", name: "Goal fixture", vendor: "deepseek", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only",
  models: [{ id: "fixture", supportsTools: true, contextWindow: 64000 }] };
export const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
export function sse(delta, finish = "stop", usage = { prompt_tokens: 200, completion_tokens: 5 }) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
export const tools = (...calls) => sse({ tool_calls: calls.map((item, index) => ({ ...item, index })) }, "tool_calls");
export const eventsResponse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
export function anthropicEvents(blocks, reason = "end_turn") {
  return [{ type: "message_start", message: { id: "msg_fixture", usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 5 } } },
    ...blocks.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block.type === "tool_use" ? { ...block, input: {} } : { ...block, ...(block.type === "text" ? { text: "" } : {}) } },
      ...(block.type === "tool_use" ? [{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]
        : block.type === "text" ? [{ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }] : []),
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 8 } }, { type: "message_stop" }];
}
export function responsesEvents(output, type = "response.completed") {
  return [{ type, response: { id: "resp_fixture", output, usage: { input_tokens: 20, output_tokens: 8, input_tokens_details: { cached_tokens: 7 } },
    ...(type === "response.incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}) } }];
}
export const outputText = (text) => ({ type: "message", id: "msg", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });

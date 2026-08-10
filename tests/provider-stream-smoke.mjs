import assert from "node:assert/strict";
import {
  callModelProviderOnce,
  createOpenAICompatibleProvider,
} from "../electron/runtime/provider-stream.js";

const originalFetch = globalThis.fetch;

function sseResponse(events, status = 200) {
  if (status !== 200) {
    return new Response(JSON.stringify(events), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const payload = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("") + "data: [DONE]\n\n";
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

try {
  const observed = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(options.headers.Authorization, "Bearer sk-test");
    return sseResponse([
      {
        choices: [
          {
            delta: {
              content: "Hello ",
              reasoning_content: "reason-a",
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "read_", arguments: '{"pa' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              content: "world",
              reasoning_content: "reason-b",
              tool_calls: [
                {
                  index: 0,
                  function: { name: "file", arguments: 'th":"src/a.js"}' },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      },
    ]);
  };

  const result = await callModelProviderOnce({
    provider: {
      id: "deepseek-test",
      name: "DeepSeek Test",
      vendor: "deepseek",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
    },
    body: { model: "deepseek-test", messages: [] },
    onEvent: (event) => observed.push(event),
  });

  assert.equal(result.message.content, "Hello world");
  assert.equal(result.message.reasoning_content, "reason-areason-b");
  assert.equal(result.message.tool_calls.length, 1);
  assert.equal(result.message.tool_calls[0].id, "call-1");
  assert.equal(result.message.tool_calls[0].function.name, "read_file");
  assert.equal(
    result.message.tool_calls[0].function.arguments,
    '{"path":"src/a.js"}',
  );
  assert.equal(result.usage.total_tokens, 16);
  assert.deepEqual(
    observed.map((event) => event.delta),
    ["Hello ", "world"],
  );

  globalThis.fetch = async () =>
    sseResponse({ error: { message: "busy" } }, 503);
  await assert.rejects(
    () =>
      callModelProviderOnce({
        provider: {
          name: "Retryable Provider",
          vendor: "openai",
          baseUrl: "https://example.com/v1",
          apiKey: "",
        },
        body: { model: "test", messages: [] },
      }),
    (error) => {
      assert.equal(error.message, "busy");
      assert.equal(error.retryable, true);
      assert.equal(error.status, 503);
      return true;
    },
  );

  const provider = createOpenAICompatibleProvider({
    config: {
      id: "provider-a",
      name: "Provider A",
      vendor: "openai",
      baseUrl: "https://example.com/v1",
      apiKey: "",
    },
    model: {
      id: "model-a",
      supportsImages: true,
      supportsTools: true,
      supportsThinking: true,
      thinkingMode: "reasoning_content",
    },
  });
  assert.equal(provider.supportsModel("model-a"), true);
  assert.equal(provider.supportsModel("model-b"), false);
  assert.equal(provider.supportsImages, true);
  assert.equal(provider.supportsTools, true);
  assert.equal(provider.supportsThinking, true);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("provider stream smoke: PASS");

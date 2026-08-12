import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  APORIA_CLOUD_MODEL_ID,
  APORIA_CLOUD_PRO_MODEL_ID,
  APORIA_CLOUD_PROVIDER_ID,
  createAporiaCloudProvider,
  normalizeProviderInput,
  publicProviderSummary,
} from "../electron/provider-config.js";
import { callModelProviderOnce } from "../electron/runtime/provider-stream.js";
import { getModelGroups } from "../src/models/model-catalog.js";

function sseResponse(events) {
  const payload = events
    .map((event) =>
      typeof event === "string"
        ? event
        : `data: ${JSON.stringify(event)}\n\n`,
    )
    .join("") + "data: [DONE]\n\n";
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const cloud = publicProviderSummary(
  createAporiaCloudProvider("http://127.0.0.1:4200"),
);
assert.equal(cloud.id, APORIA_CLOUD_PROVIDER_ID);
assert.equal(cloud.kind, "aporia-cloud");
assert.equal(cloud.source, "aporia-cloud");
assert.equal(cloud.billing, "weekly-quota");
assert.equal(cloud.managed, true);
assert.equal(cloud.requiresAccount, true);
assert.equal(cloud.hasApiKey, false);
assert.equal(cloud.models.length, 2);
assert.equal(cloud.models[0].id, APORIA_CLOUD_MODEL_ID);
assert.equal(cloud.models[0].name, "DeepSeek V4 Flash");
assert.equal(cloud.models[0].contextWindow, 1_000_000);
assert.equal(cloud.models[1].id, APORIA_CLOUD_PRO_MODEL_ID);
assert.equal(cloud.models[1].name, "DeepSeek V4 Pro");
assert.equal(cloud.models[1].shortName, "V4 Pro");
assert.equal(cloud.models[1].supportsThinking, true);
assert.equal(cloud.models[1].thinkingMode, "deepseek");
assert.equal(cloud.models[1].supportsTools, true);
assert.equal(cloud.models[1].contextWindow, 1_000_000);

const byok = publicProviderSummary(
  normalizeProviderInput({
    id: "user-deepseek",
    name: "My DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash"],
  }),
);
assert.equal(byok.source, "user-provider");
assert.equal(byok.billing, "user-provider");
assert.equal(byok.managed, false);

const local = publicProviderSummary(
  normalizeProviderInput({
    id: "local-openai",
    name: "Local Model",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["qwen-local"],
  }),
);
assert.equal(local.source, "local");
assert.equal(local.billing, "none");

const groups = getModelGroups([byok, local, cloud]);
assert.deepEqual(
  groups.map((group) => group.source),
  ["aporia-cloud", "user-provider", "local"],
);
assert.equal(groups[0].models.length, 2);
assert.equal(groups[0].models[0].descriptionZh.includes("每周额度"), true);
assert.equal(groups[0].models[1].name, "DeepSeek V4 Pro");
assert.equal(groups[1].models[0].descriptionEn.includes("Your API"), true);
assert.equal(groups[2].models[0].descriptionEn.includes("Local"), true);

const observedRequests = [];
const cloudRuntimeProvider = {
  ...cloud,
  authenticatedFetch: async (path, init) => {
    observedRequests.push({ path, init });
    return sseResponse([
      {
        choices: [
          {
            delta: {
              reasoning_content: "plan",
              content: "Cloud ",
              tool_calls: [
                {
                  index: 0,
                  id: "call-cloud-1",
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
              content: "works",
              tool_calls: [
                {
                  index: 0,
                  function: { name: "file", arguments: 'th":"README.md"}' },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 20,
          total_tokens: 140,
        },
      },
    ]);
  },
};

const streamed = await callModelProviderOnce({
  provider: cloudRuntimeProvider,
  body: {
    model: APORIA_CLOUD_MODEL_ID,
    messages: [{ role: "user", content: "test" }],
  },
});
assert.equal(streamed.message.content, "Cloud works");
assert.equal(streamed.message.reasoning_content, "plan");
assert.equal(streamed.message.tool_calls[0].function.name, "read_file");
assert.equal(streamed.message.tool_calls[0].function.arguments, '{"path":"README.md"}');
assert.equal(streamed.usage.total_tokens, 140);
assert.equal(observedRequests.length, 1);
assert.equal(observedRequests[0].path, "/v1/chat/completions");
const observedHeaders = new Headers(observedRequests[0].init.headers || {});
assert.equal(observedHeaders.has("Authorization"), false);
const observedBody = JSON.parse(observedRequests[0].init.body);
assert.equal(observedBody.model, APORIA_CLOUD_MODEL_ID);
assert.equal(observedBody.stream, true);

const proStreamed = await callModelProviderOnce({
  provider: cloudRuntimeProvider,
  body: {
    model: APORIA_CLOUD_PRO_MODEL_ID,
    messages: [{ role: "user", content: "pro test" }],
  },
});
assert.equal(proStreamed.message.content, "Cloud works");
assert.equal(observedRequests.length, 2);
const observedProBody = JSON.parse(observedRequests[1].init.body);
assert.equal(observedProBody.model, APORIA_CLOUD_PRO_MODEL_ID);
assert.equal(observedProBody.stream, true);

await assert.rejects(
  () =>
    callModelProviderOnce({
      provider: {
        ...cloud,
        authenticatedFetch: async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "WEEKLY_QUOTA_EXHAUSTED",
                type: "quota_error",
              },
            }),
            {
              status: 402,
              headers: { "Content-Type": "application/json" },
            },
          ),
      },
      body: {
        model: APORIA_CLOUD_MODEL_ID,
        messages: [{ role: "user", content: "quota" }],
      },
    }),
  (error) => {
    assert.equal(error.code, "WEEKLY_QUOTA_EXHAUSTED");
    assert.equal(error.status, 402);
    assert.equal(error.retryable, false);
    assert.match(error.message, /Your Providers|Local/);
    return true;
  },
);

await assert.rejects(
  () =>
    callModelProviderOnce({
      provider: {
        ...cloud,
        authenticatedFetch: async () =>
          sseResponse([
            "event: aporia_error\n",
            `data: ${JSON.stringify({ error: "APORIA_PROVIDER_UNAVAILABLE" })}\n\n`,
          ]),
      },
      body: {
        model: APORIA_CLOUD_MODEL_ID,
        messages: [{ role: "user", content: "stream error" }],
      },
    }),
  (error) => {
    assert.equal(error.code, "APORIA_PROVIDER_UNAVAILABLE");
    assert.equal(error.retryable, false);
    return true;
  },
);

const accountRuntimeSource = await readFile(
  new URL("../electron/account/desktop-account-runtime.js", import.meta.url),
  "utf8",
);
const preloadSource = await readFile(
  new URL("../electron/preload.cjs", import.meta.url),
  "utf8",
);
const mainSource = await readFile(
  new URL("../electron/main.js", import.meta.url),
  "utf8",
);

assert.match(accountRuntimeSource, /fetchModelGateway/);
assert.match(accountRuntimeSource, /APORIAX_MODEL_GATEWAY_URL/);
assert.doesNotMatch(accountRuntimeSource, /getAccessToken\s*[:=(]/);
assert.doesNotMatch(preloadSource, /getAccessToken|fetchModelGateway/);
assert.match(mainSource, /APORIA_CLOUD_PROVIDER_ID/);
assert.match(mainSource, /authenticatedFetch/);
assert.match(mainSource, /publicAporiaCloudProvider/);

console.log("Aporia Cloud model runtime smoke: PASS");
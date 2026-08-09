import assert from "node:assert/strict";
import {
  mergeTokenUsage,
  upsertRelevantContextMessage,
} from "../electron/agent-context.js";
import {
  DEFAULT_DEEPSEEK_PROVIDER,
  normalizeProviderModels,
  publicProviderSummary,
} from "../electron/provider-config.js";

assert.equal(DEFAULT_DEEPSEEK_PROVIDER.models[0].contextWindow, 1_000_000);
assert.equal(DEFAULT_DEEPSEEK_PROVIDER.models[1].contextWindow, 1_000_000);
assert.equal(
  normalizeProviderModels([{ id: "deepseek-v4-pro" }], "deepseek")[0]
    .contextWindow,
  1_000_000,
);
assert.equal(
  publicProviderSummary({
    id: "deepseek",
    name: "DeepSeek",
    kind: "openai-compatible",
    vendor: "deepseek",
    baseUrl: "https://api.deepseek.com",
    models: [{ id: "deepseek-v4-flash" }],
  }).models[0].contextWindow,
  1_000_000,
);

assert.deepEqual(
  mergeTokenUsage(
    {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 75,
      prompt_cache_miss_tokens: 25,
    },
    {
      input_tokens: 80,
      output_tokens: 10,
      prompt_cache_hit_tokens: 60,
      prompt_cache_miss_tokens: 20,
    },
  ),
  {
    prompt_tokens: 180,
    completion_tokens: 30,
    total_tokens: 210,
    prompt_cache_hit_tokens: 135,
    prompt_cache_miss_tokens: 45,
  },
);

const memoryFacts = [
  {
    id: "cache-fact",
    category: "architecture",
    content: "DeepSeek cache prefix should remain stable across agent rounds.",
    evidence: "cache smoke test",
  },
];
const conversation = [
  { role: "system", content: "Stable system prompt" },
  { role: "user", content: "Improve DeepSeek cache prefix stability." },
];

const first = upsertRelevantContextMessage(conversation, {
  checkpoints: [],
  memoryFacts,
});
assert(first.length > 0);
const firstMessage = conversation.find((message) =>
  String(message.content || "").startsWith(
    "AporiaX relevant durable context:",
  ),
);
assert(firstMessage);
assert.equal(firstMessage.content.includes('"score"'), false);
const stableContent = firstMessage.content;

conversation.push({ role: "assistant", content: "Different recent response." });
conversation.push({ role: "user", content: "Now discuss an unrelated detail." });
upsertRelevantContextMessage(conversation, {
  checkpoints: [],
  memoryFacts: [
    {
      ...memoryFacts[0],
      content: "A changed fact must not rewrite the prefix during a normal round.",
    },
  ],
});
const stableMessages = conversation.filter((message) =>
  String(message.content || "").startsWith(
    "AporiaX relevant durable context:",
  ),
);
assert.equal(stableMessages.length, 1);
assert.equal(stableMessages[0].content, stableContent);

upsertRelevantContextMessage(conversation, {
  checkpoints: [
    {
      createdAt: "checkpoint-1",
      requirements: ["DeepSeek cache prefix stability"],
      decisions: [],
      evidence: [],
    },
  ],
  memoryFacts,
});
const afterCompactionMessages = conversation.filter((message) =>
  String(message.content || "").startsWith(
    "AporiaX relevant durable context:",
  ),
);
assert.equal(afterCompactionMessages.length, 1);
assert.equal(afterCompactionMessages[0].content, stableContent);

console.log("deepseek cache smoke: PASS");

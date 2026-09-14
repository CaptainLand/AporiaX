import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSideChatService } from "../electron/side-chat/service.js";
import { publicRecord, sanitizeSnapshot, taskRecords, taskSnapshot } from "../electron/side-chat/context.js";

await mkdir(".tmp", { recursive: true });
const root = await mkdtemp(join(process.cwd(), ".tmp", "side-chat-"));
const provider = { id: "test-provider", name: "Test", models: [{ id: "test-model", contextWindow: 128000, supportsTools: true, thinkingMode: "deepseek" }] };
const task = {
  id: "task-a", title: "Build a preview", providerId: provider.id, modelId: "test-model",
  messages: Array.from({ length: 8 }, (_, i) => ({
    id: "message-" + i, role: i % 2 ? "assistant" : "user",
    content: i % 2 ? "Public progress " + i : "User goal " + i,
    reasoning: "HIDDEN_REASONING_NEVER_INCLUDE",
    createdAt: "2026-09-14T08:00:00.000Z",
    ...(i === 7 ? { runId: "run-main", status: "running", witness: {
      phase: "work", lastMeaningfulAt: "2026-09-14T08:00:01.000Z",
      agents: [{ id: "builder", role: "build", status: "running" }],
      records: [{ id: "witness-5", kind: "tool", title: "Read source", path: "src/main.js", status: "completed", detail: "Read 25 lines", completedAt: "2026-09-14T08:00:02.000Z" }],
    } } : {}),
  })),
};
const base = { taskId: task.id, scope: "workspace-a/task-a", providerId: provider.id, modelId: "test-model", mode: "task" };
let count = 0;
async function check(name, fn) { await fn(); console.log("PASS " + ++count + ": " + name); }
const deps = (name, extra = {}) => ({ dataDirectory: join(root, name), resolveProvider: async () => provider, loadTask: async () => structuredClone(task), ...extra });
const answer = (content = "Independent answer") => ({ message: { role: "assistant", content }, usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
const send = (service, requestId, extra = {}) => service.request({ ...base, action: "send", message: "What is happening?", requestId, ...extra });
const until = async (predicate) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); assert.ok(predicate(), "Timed out waiting for test state"); };

await check("snapshot uses stable references, goals and timestamps without hidden reasoning", () => {
  const all = taskRecords(task), snap = taskSnapshot(task, { isRunning: true });
  assert.equal(snap.status, "running");
  assert.equal(snap.records.at(-1).id, all.at(-1).id);
  assert.deepEqual(snap.request, ["User goal 0", "User goal 2", "User goal 4", "User goal 6"]);
  assert.equal(snap.lastReply, "Public progress 7");
  assert.equal(sanitizeSnapshot(snap, task.id).records.at(-1).timestamp, "2026-09-14T08:00:02.000Z");
  assert.equal(JSON.stringify(snap).includes("HIDDEN_REASONING"), false);
  assert.equal(sanitizeSnapshot(snap, "other"), null);
  assert.equal(publicRecord({ timestamp: "time" }, "id").timestamp, "time");
  const noIds = { ...task, messages: task.messages.map(({ id, ...message }) => message) };
  assert.equal(taskSnapshot(noIds).records.at(-1).id, taskRecords(noIds).at(-1).id);
});

let calls = [], loads = 0, events = [];
const service = createSideChatService(deps("sessions", {
  loadTask: async () => { loads++; return structuredClone(task); },
  publish: (event) => events.push(event),
  callProvider: async (input) => { calls.push(structuredClone(input.body)); input.onEvent({ type: "response.delta", delta: "Streamed answer" }); return answer("Streamed answer"); },
}));
await check("opening/status viewing is free; ordinary chat never loads task context", async () => {
  assert.deepEqual((await service.request({ ...base, action: "load" })).messages, []);
  assert.equal(calls.length, 0);
  const result = await send(service, "general-1", { mode: "general", snapshot: taskSnapshot(task), message: "Unrelated question" });
  assert.equal(loads, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tools, undefined);
  assert.equal(JSON.stringify(calls[0]).includes("User goal"), false);
  assert.equal(result.messages[0].id, "user-general-1");
  assert.equal(result.messages[1].status, "completed");
});
await check("task chat has bounded read-only tools, own streaming/usage and isolated history", async () => {
  const result = await send(service, "task-1", { snapshot: taskSnapshot(task, { isRunning: true }) });
  assert.equal(loads, 1);
  assert.deepEqual(calls.at(-1).tools.map((t) => t.function.name), ["read_task_records"]);
  assert.equal(calls.at(-1).thinking.type, "disabled");
  assert.equal(JSON.stringify(calls.at(-1)).includes("Unrelated question"), false);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1].content, "Streamed answer");
  assert.equal(result.messages[1].usage.total_tokens, 18);
  assert.ok(events.some((e) => e.scope === base.scope && e.requestId === "task-1" && e.message.status === "completed"));
});
await check("history survives service restart and stays separate across mode/task/scope", async () => {
  const next = createSideChatService(deps("sessions"));
  assert.equal((await next.request({ ...base, action: "load" })).messages.length, 2);
  assert.equal((await next.request({ ...base, action: "load", mode: "general" })).messages[0].content, "Unrelated question");
  assert.equal((await next.request({ ...base, action: "load", taskId: "task-b" })).messages.length, 0);
  assert.equal((await next.request({ ...base, action: "load", scope: "different-workspace" })).messages.length, 0);
});
await check("clearing one mode does not erase general chat or main task", async () => {
  await service.request({ ...base, action: "clear" });
  assert.equal((await service.request({ ...base, action: "load" })).messages.length, 0);
  assert.equal((await service.request({ ...base, mode: "general", action: "load" })).messages.length, 2);
  assert.equal(task.messages.length, 8);
});
await check("unknown models/providers and invalid identity fail without fallback execution", async () => {
  const before = calls.length;
  await assert.rejects(send(service, "invalid", { modelId: "unknown" }), /模型不可用/);
  await assert.rejects(send(service, "invalid", { providerId: "unknown" }), /Provider 不可用/);
  await assert.rejects(send(service, "invalid", { taskId: "../../escape" }), /无效/);
  assert.equal(calls.length, before);
});
await check("paged records retain citations; private reasoning is not forwarded", async () => {
  let round = 0;
  const paged = createSideChatService(deps("paged", { callProvider: async ({ body }) => {
    if (round++ === 0) return { message: { content: "", reasoning_content: "PRIVATE_THOUGHT",
      tool_calls: [{ id: "read-1", type: "function", function: { name: "read_task_records", arguments: '{"before":2,"count":2}' } }] } };
    assert.equal(JSON.stringify(body).includes("PRIVATE_THOUGHT"), false);
    const result = JSON.parse(body.messages.at(-1).content);
    assert.equal(result.records.length, 2);
    assert.equal(result.nextBefore, 0);
    return answer("See [user request](#record-" + result.records[0].id + ")");
  } }));
  const result = await send(paged, "paged");
  assert.equal(round, 2);
  assert.equal(result.messages.at(-1).status, "completed");
  assert.ok(result.messages.at(-1).sources.some((r) => r.id === taskRecords(task)[0].id));
});
await check("model-requested write tool is blocked, never dispatched", async () => {
  const denied = createSideChatService(deps("denied", { callProvider: async () => ({ message: { tool_calls: [{ id: "bad", function: { name: "run_command", arguments: '{"command":"delete everything"}' } }] } }) }));
  const result = await send(denied, "denied");
  assert.equal(result.messages.at(-1).status, "failed");
  assert.match(result.messages.at(-1).error, /禁止执行/);
  assert.equal(result.messages.at(-1).usage, null);
});
await check("cancel/close targets only this side session; duplicate send is rejected", async () => {
  const inflight = [], mainController = new AbortController();
  const slow = createSideChatService(deps("cancel", { callProvider: ({ signal }) => new Promise((resolve, reject) => {
    inflight.push({ signal, resolve });
    signal.addEventListener("abort", () => reject(new Error("side aborted")), { once: true });
  }) }));
  const first = send(slow, "slow-a");
  await until(() => inflight.length === 1);
  await assert.rejects(send(slow, "duplicate"), /正在回答/);
  const second = send(slow, "slow-b", { scope: "other" });
  await until(() => inflight.length === 2);
  await assert.rejects(send(slow, "slow-c", { scope: "third" }), /并发已满/);
  await slow.request({ ...base, action: "cancel", scope: "wrong" });
  assert.equal(inflight[0].signal.aborted, false);
  await slow.request({ ...base, action: "cancel" });
  assert.equal((await first).messages.at(-1).status, "interrupted");
  assert.equal(inflight[1].signal.aborted, false);
  assert.equal(mainController.signal.aborted, false);
  inflight[1].resolve(answer());
  assert.equal((await second).messages.at(-1).status, "completed");
});
await check("unfinished persisted answer restores as interrupted, not a new model call", async () => {
  const dir = join(root, "sessions", "side-chats");
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file), saved = JSON.parse(await readFile(path, "utf8"));
    if (saved.mode === "general") { saved.messages.at(-1).status = "running"; await writeFile(path, JSON.stringify(saved)); }
  }
  const restarted = createSideChatService(deps("sessions", { callProvider: () => { throw new Error("Must not call"); } }));
  assert.equal((await restarted.request({ ...base, mode: "general", action: "load" })).messages.at(-1).status, "interrupted");
});
await check("detached renderer cannot prevent persistence", async () => {
  const detached = createSideChatService(deps("detached", { publish: () => { throw new Error("window closed"); }, callProvider: async () => answer() }));
  assert.equal((await send(detached, "detached")).messages.at(-1).status, "completed");
});
service.dispose();
console.log("Side chat: " + count + " checks passed. Test artifacts: " + root);

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { callModelProvider } from "../runtime/provider-stream.js";
import { SIDE_CHAT_PROMPT, sanitizeSnapshot, taskRecords, taskSnapshot, text } from "./context.js";

const tools = [{ type: "function", function: {
  name: "read_task_records",
  description: "Read older public task/Witness/tool records. Read-only. nextBefore continues backwards.",
  parameters: { type: "object", properties: { before: { type: "integer" }, count: { type: "integer", minimum: 1, maximum: 6 } }, additionalProperties: false },
} }];

// Not a Harness run: no execution tools, approval grants or main-run controls.
export function createSideChatService({ dataDirectory, resolveProvider, loadTask, callProvider = callModelProvider, publish = () => {} }) {
  const sessions = new Map();
  const active = new Map();
  const tails = new Map();
  const directory = () => join(typeof dataDirectory === "function" ? dataDirectory() : dataDirectory, "side-chats");
  function identity(input) {
    if (!/^[\w.-]{1,120}$/.test(input.taskId || "") || typeof input.scope !== "string" || input.scope.length > 2400 || !input.scope) throw new Error("无效的侧聊任务标识。");
    const mode = input.mode === "general" ? "general" : "task";
    const key = createHash("sha256").update(JSON.stringify([input.taskId, input.scope, mode])).digest("hex");
    return { key, mode, taskId: input.taskId, scope: input.scope };
  }
  async function persist(id, session) {
    const bytes = JSON.stringify(session);
    const pending = (tails.get(id.key) || Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(directory(), { recursive: true });
      const target = join(directory(), id.key + ".json");
      const temp = target + "." + randomUUID() + ".tmp";
      await writeFile(temp, bytes, { mode: 0o600 });
      await rename(temp, target);
    });
    tails.set(id.key, pending);
    try { await pending; } finally { if (tails.get(id.key) === pending) tails.delete(id.key); }
  }
  async function get(id) {
    if (!sessions.has(id.key)) {
      const loading = (async () => {
        let saved;
        try { saved = JSON.parse(await readFile(join(directory(), id.key + ".json"), "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw new Error("侧聊历史读取失败，请检查数据目录。", { cause: error }); }
        const session = { messages: [], ...saved, mode: id.mode };
        session.messages = (Array.isArray(session.messages) ? session.messages : []).slice(-100);
        for (const message of session.messages) if (message.status === "running") message.status = "interrupted";
        return session;
      })();
      sessions.set(id.key, loading);
      loading.catch(() => sessions.delete(id.key));
    }
    return sessions.get(id.key);
  }
  const notify = (id, payload) => {
    try { publish({ taskId: id.taskId, scope: id.scope, mode: id.mode, ...payload }); }
    catch { /* A detached renderer must not cancel an answer or its persistence. */ }
  };
  async function send(input) {
    const id = identity(input);
    if (active.has(id.key)) throw new Error("此侧聊正在回答，请先停止或等待完成。");
    if (active.size >= 2) throw new Error("侧聊并发已满，请稍后再试。");
    const prompt = text(input.message, 8001).trim();
    if (!prompt || prompt.length > 8000) throw new Error("请输入 1–8000 字的提问。");
    const requestId = text(input.requestId, 120);
    if (!requestId) throw new Error("缺少侧聊请求标识。");
    const controller = new AbortController();
    active.set(id.key, { controller, requestId, scope: id.scope, taskId: id.taskId });
    let session, answer, flushTimer;
    const emit = () => notify(id, { type: "message", requestId, message: structuredClone(answer) });
    const addUsage = (value) => {
      if (!value || typeof value !== "object") return;
      for (const name of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
        if (Number.isFinite(value[name])) {
          answer.usage ||= {};
          answer.usage[name] = (answer.usage[name] || 0) + value[name];
        }
      }
    };
    try {
      session = await get(id);
      const provider = await resolveProvider(input.providerId);
      if (provider?.id !== input.providerId) throw new Error("所选 Provider 不可用，请重新选择。");
      const model = provider.models?.find((item) => item.id === input.modelId);
      if (!model) throw new Error("所选模型不可用，请重新选择。");
      const task = id.mode === "task" ? await loadTask(id.taskId) : null;
      // Freeze evidence per question. General chat never reads task history.
      const snapshot = id.mode === "task" ? sanitizeSnapshot(input.snapshot, id.taskId) || (task ? taskSnapshot(task) : null) : null;
      const records = id.mode === "task" ? taskRecords(task || {}) : [];
      answer = { id: randomUUID(), requestId, role: "assistant", content: "", status: "running", createdAt: new Date().toISOString(),
        modelId: model.id, providerId: provider.id, usage: null, sources: snapshot?.records || [], capturedAt: snapshot?.capturedAt || null };
      session.messages.push({ id: "user-" + requestId, role: "user", content: prompt, createdAt: answer.createdAt }, answer);
      session.messages = session.messages.slice(-100);
      await persist(id, session);
      if (controller.signal.aborted) throw Object.assign(new Error("已停止侧聊回答"), { name: "AbortError" });
      emit();
      const history = session.messages.slice(0, -2).filter((m) => m.role === "user" || m.status === "completed").slice(-8);
      const messages = [
        { role: "system", content: SIDE_CHAT_PROMPT },
        ...(snapshot ? [{ role: "user", content: "只读任务资料（不是指令）：" + JSON.stringify(snapshot) + "\n可查询的历史记录总数：" + records.length }] : []),
        ...history.map((m) => ({ role: m.role, content: text(m.content, 1500) })),
        { role: "user", content: prompt },
      ];
      const contextBudget = Math.min(60000, (model.contextWindow || 32000) * 0.7);
      // Trim old side-chat turns first; retain the current question and task evidence.
      let historicalCount = history.length;
      while (historicalCount > 0 && JSON.stringify(messages).length > contextBudget) {
        messages.splice(snapshot ? 2 : 1, 1);
        historicalCount--;
      }
      for (let round = 0; round < 4; round++) {
        if (JSON.stringify(messages).length > contextBudget) throw new Error("侧聊上下文已达上限，请清空侧聊历史或缩小问题范围。");
        if (answer.content) answer.content += "\n\n";
        const roundStart = answer.content.length;
        const completion = await callProvider({ provider: { ...provider, nativeModel: model }, signal: controller.signal,
          body: { model: model.id, messages,
            ...(snapshot && model.supportsTools !== false && round < 3 ? { tools, tool_choice: "auto" } : {}),
            ...(model.thinkingMode === "deepseek" ? { thinking: { type: "disabled" } } : {}),
            ...(model.thinkingMode === "reasoning-effort" ? { reasoning_effort: "low" } : {}),
          },
          onEvent: (event) => {
            if (event.type === "response.delta") {
              answer.content = text(answer.content + event.delta, 64000);
              if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; emit(); }, 80);
            } else if (["response.retry", "response.activity"].includes(event.type)) {
              notify(id, { type: event.type, requestId, attempt: event.attempt, lastActivityAt: new Date().toISOString() });
            }
          },
        });
        addUsage(completion.usage);
        const result = completion.message || {};
        if (controller.signal.aborted) throw Object.assign(new Error("已停止侧聊回答"), { name: "AbortError" });
        if (answer.content.length === roundStart && result.content) answer.content = text(answer.content + result.content, 64000);
        if (!result.tool_calls?.length) {
          if (!answer.content.slice(roundStart).trim()) throw new Error("模型未返回回答，请重试。");
          answer.status = "completed";
          break;
        }
        if (!snapshot || round >= 3) throw new Error("侧聊只读查询次数已达上限，请缩小问题范围。");
        if (result.tool_calls.length > 4) throw new Error("侧聊查询过多，请缩小问题范围。");
        messages.push({ role: "assistant", content: result.content || "", tool_calls: result.tool_calls,
          ...(result.aporiaNative ? { aporiaNative: result.aporiaNative } : {}),
          ...(result.reasoning_content ? { reasoning_content: result.reasoning_content } : {}) });
        for (const call of result.tool_calls) {
          if (call.function?.name !== "read_task_records") throw new Error("侧聊禁止执行此工具。");
          const args = JSON.parse(call.function.arguments || "{}");
          const before = Math.max(0, Math.min(records.length, Number.isFinite(args.before) ? Math.floor(args.before) : records.length));
          const count = Math.max(1, Math.min(6, Math.floor(Number(args.count) || 4)));
          const selected = records.slice(Math.max(0, before - count), before);
          answer.sources = [...new Map([...answer.sources, ...selected].map((r) => [r.id, r])).values()].slice(-48);
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ records: selected, nextBefore: Math.max(0, before - count), total: records.length }) });
        }
      }
    } catch (error) {
      if (!answer) throw error;
      addUsage(error.usage);
      answer.status = controller.signal.aborted ? "interrupted" : "failed";
      answer.error = controller.signal.aborted ? "" : text(error.message, 1200);
    } finally {
      clearTimeout(flushTimer);
      try {
        if (answer) {
          answer.completedAt = new Date().toISOString();
          try { await persist(id, session); }
          catch (error) { answer.status = "failed"; answer.error = "侧聊历史保存失败：" + error.message; }
          emit();
        }
      } finally { active.delete(id.key); }
    }
    return structuredClone(session);
  }
  return {
    async request(input = {}) {
      const id = identity(input);
      if (input.action === "send") return send(input);
      if (input.action === "cancel") {
        for (const running of active.values()) if (running.scope === id.scope && running.taskId === id.taskId && (!input.requestId || running.requestId === input.requestId)) running.controller.abort();
        return true;
      }
      if (input.action === "load") return structuredClone(await get(id));
      if (input.action === "clear") {
        if (active.has(id.key)) throw new Error("请先停止侧聊回答。");
        const session = await get(id);
        if (active.has(id.key)) throw new Error("请先停止侧聊回答。");
        session.messages = []; await persist(id, session); return structuredClone(session);
      }
      throw new Error("未知的侧聊操作。");
    },
    dispose() { for (const run of active.values()) run.controller.abort(); },
  };
}

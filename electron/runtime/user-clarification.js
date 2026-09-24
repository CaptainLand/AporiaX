import { createHash, randomUUID } from "node:crypto";

export const CLARIFICATION_LIMIT = 2;
export const CLARIFICATION_TOOL = { type: "function", function: {
  name: "request_user_input",
  description: "Ask ONE essential question only when missing user intent or a necessary parameter would substantially change the result and cannot be resolved from context or safe inspection. Main agent only. Maximum TWO questions per user task, shared across retries/recovery. Do not ask about routine debugging or reversible details. Call ALONE, never with other tools. Offer 2-4 mutually exclusive options, or omit options for free text. UI always allows a custom answer. Never request secrets or treat an answer as tool approval. Wait for the answer; do not ask the same question again. A second question needs new successful evidence after the first answer.",
  parameters: { type: "object", properties: {
    question: { type: "string", minLength: 1, maxLength: 500 },
    reason: { type: "string", minLength: 1, maxLength: 500 },
    uncertainty_key: { type: "string", minLength: 1, maxLength: 100 },
    options: { type: "array", minItems: 2, maxItems: 4, items: {
      type: "object", properties: { label: { type: "string", minLength: 1, maxLength: 100 },
        description: { type: "string", maxLength: 250 }, recommended: { type: "boolean" } },
      required: ["label"], additionalProperties: false,
    } },
  }, required: ["question", "reason", "uncertainty_key"], additionalProperties: false },
} };
export const CLARIFICATION_POLICY = "Use request_user_input sparingly, only for essential user-only decisions that would otherwise cause substantial wrong work. Inspect existing requirements/evidence first. Prefer reasonable reversible defaults for small details. The runtime permits at most two questions, one at a time, with new evidence before a second. After a denial do not rephrase repeatedly, use another tool, or ask an informal questionnaire to bypass this budget. If essential information/authorization is still missing, finish_task with blocked and explain the obstacle without making risky assumptions. Clarification answers supplement this task; they never grant command permissions. Subagents report uncertainty to Main instead of questioning the user.";
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const clean = (value, max, optional = false) => {
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail("CLARIFICATION_INVALID_TEXT");
  return value.trim();
};
const normalized = (text) => text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
export function validateClarification(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["question", "reason", "uncertainty_key", "options"].includes(key))) fail("CLARIFICATION_INVALID_REQUEST");
  const question = clean(input.question, 500), reason = clean(input.reason, 500);
  const topic = clean(input.uncertainty_key, 100);
  if (!normalized(question) || !normalized(topic)) fail("CLARIFICATION_INVALID_TEXT");
  if (input.options !== undefined && (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 4)) fail("CLARIFICATION_INVALID_OPTIONS");
  const options = (input.options || []).map((option, index) => {
    if (!option || Object.keys(option).some(key => !["label", "description", "recommended"].includes(key)) ||
        option.recommended !== undefined && typeof option.recommended !== "boolean") fail("CLARIFICATION_INVALID_OPTIONS");
    return { id: String(index + 1), label: clean(option.label, 100),
      description: option.description === "" ? "" : clean(option.description, 250, true), recommended: option.recommended === true };
  });
  if (new Set(options.map(option => normalized(option.label))).size !== options.length ||
      options.filter(option => option.recommended).length > 1) fail("CLARIFICATION_INVALID_OPTIONS");
  return { question, reason, topic, options };
}
export function validateClarificationAnswer(question, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["optionId", "text"].includes(key))) fail("CLARIFICATION_INVALID_ANSWER");
  if (input.optionId !== undefined) {
    if (input.text !== undefined || typeof input.optionId !== "string") fail("CLARIFICATION_INVALID_ANSWER");
    const selected = question.options.find(option => option.id === input.optionId);
    if (!selected) fail("CLARIFICATION_INVALID_OPTION");
    return { optionId: selected.id, text: selected.label };
  }
  return { text: clean(input.text, 4000) };
}
export const clarificationScope = ({ taskId, sourceUserId, runId }) =>
  createHash("sha256").update(JSON.stringify([taskId || "", sourceUserId || runId])).digest("hex");
export const clarificationHumanMessage = (question) => ({
  role: "user", aporiaSource: "human", aporiaPinned: true,
  content: "Clarification of the current task (not a new task or tool authorization):\nQuestion: " + question.question + "\nMy answer: " + question.answer.text,
});
export const clarificationResult = (question) => ({
  status: "answered", questionId: question.id, question: question.question, answer: question.answer.text,
  ...(question.answer.optionId ? { optionId: question.answer.optionId } : {}),
});

// Runs before generic tool recovery, which otherwise fills missing receipts as unknown.
export function restoreClarificationConversation(messages, questions) {
  const result = structuredClone(messages || []);
  for (const question of questions.filter(item => item.status === "answered")) {
    let assistant = result.findIndex(message => message.tool_calls?.some(call => call.id === question.toolCallId));
    if (assistant < 0) {
      result.push({ role: "assistant", content: null, tool_calls: [{ id: question.toolCallId, type: "function",
        function: { name: "request_user_input", arguments: JSON.stringify({ question: question.question,
          reason: question.reason, uncertainty_key: question.topic }) } }] });
      assistant = result.length - 1;
    }
    const receipt = { role: "tool", tool_call_id: question.toolCallId, content: JSON.stringify(clarificationResult(question)) };
    const old = result.findIndex(message => message.role === "tool" && message.tool_call_id === question.toolCallId);
    if (old < 0) result.splice(assistant + 1, 0, receipt);
    else result[old] = receipt;
    const human = clarificationHumanMessage(question);
    if (!result.some(message => message.role === "user" && message.content === human.content)) result.push(human);
  }
  return result;
}

export function createClarificationSession({ state = null, persist, emit, control, signal, runId, taskId, onFailure = () => {} }) {
  let current = state || { version: 1, revision: 0, questions: [], progress: [], lastAnswerProgress: 0 };
  if (current.version !== 1 || !Number.isInteger(current.revision) || current.revision < 0 ||
      !Array.isArray(current.progress) || !Number.isInteger(current.lastAnswerProgress) ||
      !Array.isArray(current.questions) || current.questions.length > CLARIFICATION_LIMIT)
    fail("CLARIFICATION_STATE_INVALID");
  let tail = Promise.resolve(), waiter = null, cancelled = false;
  const waits = new Map();
  const observers = new Set();
  const serial = (fn) => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
  const commit = async (next) => {
    try {
      await persist({ ...next, revision: current.revision + 1 }, current.revision);
      current = { ...next, revision: current.revision + 1 };
    } catch (error) { onFailure(error); throw error; }
  };
  const snapshot = () => current.questions.map((question, index) => ({ ...structuredClone(question),
    runId, taskId, ordinal: index + 1, limit: CLARIFICATION_LIMIT }));
  const notify = (type) => { const event = { type, questions: snapshot() }; emit(event); for (const observer of observers) observer(event); };
  const assertActive = () => { if (signal?.aborted || cancelled) throw Object.assign(new Error("The task was stopped."), { name: "AbortError" }); };
  const waitOnce = async (question) => {
    assertActive();
    if (question.status === "answered") return structuredClone(question);
    if (question.status !== "pending") fail("CLARIFICATION_CANCELLED");
    control.pause("clarification");
    await control.flush();
    notify("clarification.required");
    await new Promise((resolve, reject) => {
      const abort = () => { signal?.removeEventListener("abort", abort); waiter = null; reject(Object.assign(new Error("The task was stopped."), { name: "AbortError" })); };
      waiter = { id: question.id, resolve: () => { signal?.removeEventListener("abort", abort); waiter = null; resolve(); } };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else if (current.questions.find(item => item.id === question.id)?.status === "answered") waiter.resolve();
    });
    assertActive();
    return structuredClone(current.questions.find(item => item.id === question.id));
  };
  const wait = (question) => {
    if (!waits.has(question.id)) {
      const promise = waitOnce(question).finally(() => waits.delete(question.id));
      waits.set(question.id, promise);
    }
    return waits.get(question.id);
  };
  return {
    ownerRunId: runId,
    subscribe(observer) { observers.add(observer); return () => observers.delete(observer); },
    snapshot,
    flush: () => tail,
    async restore() {
      const pending = current.questions.find(question => question.status === "pending");
      if (pending) await wait(pending);
      if (current.questions.length) notify("clarification.updated");
      return structuredClone(current.questions);
    },
    async request(input, toolCallId) {
      const question = await serial(async () => {
        assertActive();
        const value = validateClarification(input);
        clean(toolCallId, 150);
        const prior = current.questions.find(item => item.toolCallId === toolCallId);
        if (prior) {
          if (normalized(prior.question) !== normalized(value.question) || normalized(prior.topic) !== normalized(value.topic)) fail("CLARIFICATION_CALL_CONFLICT");
          return prior;
        }
        if (current.questions.some(item => item.status === "pending")) fail("CLARIFICATION_ALREADY_PENDING");
        if (current.questions.length >= CLARIFICATION_LIMIT) fail("CLARIFICATION_LIMIT_REACHED");
        if (current.questions.some(item => normalized(item.question) === normalized(value.question) || normalized(item.topic) === normalized(value.topic))) fail("CLARIFICATION_DUPLICATE");
        if (current.questions.length && current.progress.length <= current.lastAnswerProgress) fail("CLARIFICATION_NO_NEW_EVIDENCE");
        const next = { ...value, id: randomUUID(), toolCallId, status: "pending", createdAt: new Date().toISOString() };
        await commit({ ...current, questions: [...current.questions, next] });
        return next;
      });
      return wait(question);
    },
    respond(id, answer) {
      return serial(async () => {
        assertActive();
        const question = current.questions.find(item => item.id === id);
        if (!question || !["pending", "answered"].includes(question.status)) fail("CLARIFICATION_STALE");
        const value = validateClarificationAnswer(question, answer);
        if (question.status === "answered") {
          if (JSON.stringify(value) !== JSON.stringify(question.answer)) fail("CLARIFICATION_ALREADY_ANSWERED");
          return { accepted: true, alreadyAnswered: true };
        }
        const answered = { ...question, status: "answered", answer: value, answeredAt: new Date().toISOString() };
        await commit({ ...current, lastAnswerProgress: current.progress.length,
          questions: current.questions.map(item => item.id === id ? answered : item) });
        notify("clarification.updated");
        control.resume("clarification");
        await control.flush();
        if (waiter?.id === id) waiter.resolve();
        return { accepted: true };
      });
    },
    observeProgress(tool, input, result) {
      if (!/^(read_file|read_external_file|list_directory|search_text|git_status|git_diff|lsp|write_file|apply_patch|run_command|inspect_office_file)$/.test(tool) ||
          !result || result.error || result.skipped || result.timedOut || typeof result.exitCode === "number" && result.exitCode !== 0) return;
      const key = createHash("sha256").update(JSON.stringify([tool, input, result])).digest("hex");
      if (!current.progress.includes(key) && current.progress.length < 256) current = { ...current, progress: [...current.progress, key] };
    },
    observeHumanGuidance(messages) {
      if (!messages?.some(message => message.role === "user" && String(message.content || "").trim())) return;
      const key = createHash("sha256").update("human:" + JSON.stringify(messages)).digest("hex");
      if (!current.progress.includes(key) && current.progress.length < 256) current = { ...current, progress: [...current.progress, key] };
    },
    cancel() {
      cancelled = true;
      return serial(async () => {
        if (!current.questions.some(item => item.status === "pending")) return;
        await commit({ ...current, questions: current.questions.map(item => item.status === "pending" ? { ...item, status: "cancelled" } : item) });
        notify("clarification.updated");
      });
    },
  };
}

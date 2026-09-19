import { createHash } from "node:crypto";

export const PROVIDER_PROTOCOLS = Object.freeze(["chat-completions", "deepseek-chat", "responses", "anthropic-messages"]);
export function normalizeProviderProtocol(value) {
  const protocol = value ?? "chat-completions";
  if (!PROVIDER_PROTOCOLS.includes(protocol)) throw new Error("PROVIDER_PROTOCOL_UNSUPPORTED");
  return protocol;
}
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = (provider, model, protocol) => hash([provider.id, provider.baseUrl.replace(/\/+$/, ""), model, protocol]);
const publicAssistant = (message) => ({ content: message.content ?? "", tool_calls: message.tool_calls || [] });
const invalid = (code) => Object.assign(new Error(code), { code, retryable: false });
function removePrivate(message, { deepseek = false } = {}) {
  const { aporiaNative, aporiaContinuation, aporiaTaskBrief, aporiaSource, aporiaPinned, aporiaSupersededBy, reasoning_content, ...wire } = message;
  return { ...wire, ...(deepseek && typeof reasoning_content === "string" ? { reasoning_content } : {}) };
}
function nativeState(message, binding, protocol) {
  const state = message.aporiaNative;
  if (!state) return null;
  if (state.version !== 1 || state.binding !== binding || state.protocol !== protocol || state.messageHash !== hash(publicAssistant(message)) || !Array.isArray(state.items))
    throw invalid("PROVIDER_NATIVE_STATE_MISMATCH: restart with public history after explicitly selecting the intended provider; opaque state is never sent to another provider/model.");
  return state.items;
}
function parts(content, protocol, role) {
  const list = Array.isArray(content) ? content : typeof content === "string" && content ? [{ type: "text", text: content }] : [];
  return list.map((part) => {
    if (part.type === "text") return { type: protocol === "responses" ? role === "assistant" ? "output_text" : "input_text" : "text", text: part.text };
    if (part.type === "image_url" && role !== "assistant") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof url !== "string") throw invalid("PROVIDER_IMAGE_INVALID");
      if (protocol === "responses") return { type: "input_image", image_url: url, detail: part.image_url?.detail || "auto" };
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
      if (match) return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
      const remote = new URL(url);
      if (remote.protocol !== "https:" || remote.username || remote.password) throw invalid("PROVIDER_IMAGE_URL_UNSUPPORTED");
      return { type: "image", source: { type: "url", url } };
    }
    throw invalid(`PROVIDER_CONTENT_UNSUPPORTED: ${part.type}`);
  });
}
function maxTokens(provider, body) {
  const value = body.max_output_tokens ?? body.max_tokens ?? provider.nativeModel?.maxOutputTokens ?? provider.maxOutputTokens ?? 8192;
  if (!Number.isSafeInteger(value) || value < 256 || value > 128000) throw invalid("PROVIDER_OUTPUT_BUDGET_INVALID");
  return value;
}

/** Convert only at the network boundary. Protocol is explicit, not guessed
 * from model names. No model/provider fallback and no credential changes.
 */
export function compileProviderWire(provider, body) {
  const protocol = normalizeProviderProtocol(provider.protocol);
  if (provider.kind === "aporia-cloud" && protocol !== "chat-completions") throw invalid("CLOUD_PROTOCOL_MANAGED");
  const binding = identity(provider, body.model, protocol);
  const endpoint = provider.baseUrl.replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses|messages)$/, "");
  const messages = body.messages || [];
  if (["chat-completions", "deepseek-chat"].includes(protocol)) {
    for (const message of messages) if (message.aporiaNative) nativeState(message, binding, protocol);
    const deepseek = protocol === "deepseek-chat" || provider.vendor === "deepseek";
    return { protocol, binding, url: `${endpoint}/chat/completions`,
      headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
      body: { ...body, messages: messages.map((m) => removePrivate(m, { deepseek })), stream: true,
        ...(deepseek || provider.vendor === "openai" ? { stream_options: { include_usage: true } } : {}) } };
  }
  const tools = (body.tools || []).map(({ type, function: fn }) => {
    if (type !== "function" || !fn?.name) throw invalid("PROVIDER_TOOL_TYPE_UNSUPPORTED");
    return protocol === "responses"
      ? { type: "function", name: fn.name, description: fn.description || "", parameters: fn.parameters, strict: false }
      : { name: fn.name, description: fn.description || "", input_schema: fn.parameters };
  });
  const choice = typeof body.tool_choice === "object" ? body.tool_choice.function?.name : body.tool_choice;
  if (protocol === "responses") {
    const input = [];
    for (const message of messages) {
      const stored = nativeState(message, binding, protocol);
      if (stored) { input.push(...structuredClone(stored)); continue; }
      if (message.role === "tool") { input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content }); continue; }
      const content = parts(message.content, protocol, message.role);
      if (content.length) input.push({ role: message.role, content });
      for (const call of message.tool_calls || []) input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
    return { protocol, binding, url: `${endpoint}/responses`, headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
      body: { model: body.model, input, stream: true, store: false, include: ["reasoning.encrypted_content"], max_output_tokens: maxTokens(provider, body),
        ...(tools.length ? { tools, tool_choice: choice && !["auto", "none", "required"].includes(choice) ? { type: "function", name: choice } : choice || "auto" } : {}),
        ...(body.reasoning_effort ? { reasoning: { effort: body.reasoning_effort } } : {}) } };
  }
  const system = [], nativeMessages = [];
  let leading = true;
  const append = (role, content) => {
    if (!content.length) return;
    if (nativeMessages.at(-1)?.role === role) nativeMessages.at(-1).content.push(...content);
    else nativeMessages.push({ role, content });
  };
  for (const message of messages) {
    const stored = nativeState(message, binding, protocol);
    if (stored) { leading = false; append("assistant", structuredClone(stored)); continue; }
    if (message.role === "system" || message.role === "developer") {
      if (leading) system.push(...parts(message.content, protocol, "user"));
      else append("user", [{ type: "text", text: `[Harness context, not a new human request]\n${message.content}` }]);
      continue;
    }
    leading = false;
    if (message.role === "tool") {
      let isError = false;
      try { const result = JSON.parse(message.content); isError = Boolean(result?.error || result?.isError); } catch { /* raw tool output */ }
      append("user", [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content, ...(isError ? { is_error: true } : {}) }]);
    } else {
      const content = parts(message.content, protocol, message.role);
      for (const call of message.tool_calls || []) {
        let args;
        try { args = JSON.parse(call.function.arguments); } catch { throw invalid("PROVIDER_TOOL_ARGUMENTS_INVALID"); }
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input: args });
      }
      append(message.role, content);
    }
  }
  const thinking = Boolean(body.reasoning_effort || body.thinking?.type === "enabled");
  const max = maxTokens(provider, body);
  const manual = provider.anthropicThinking === "manual";
  const budget = provider.thinkingBudget ?? 2048;
  if (thinking && manual && (!Number.isSafeInteger(budget) || budget < 1024 || budget >= max)) throw invalid("ANTHROPIC_THINKING_BUDGET_INVALID");
  return { protocol, binding, url: `${endpoint}/messages`,
    headers: { "anthropic-version": "2023-06-01", ...(provider.apiKey ? { "x-api-key": provider.apiKey } : {}) },
    body: { model: body.model, messages: nativeMessages, ...(system.length ? { system } : {}), stream: true, max_tokens: max,
      ...(tools.length ? { tools, tool_choice: choice && !["auto", "none", "required"].includes(choice) ? { type: "tool", name: choice } : { type: choice === "required" ? "any" : choice || "auto" } } : {}),
      ...(thinking ? manual ? { thinking: { type: "enabled", budget_tokens: budget } }
        : { thinking: { type: "adaptive" }, output_config: { effort: body.reasoning_effort || "high" } } : {}) } };
}

async function* sseEvents(stream) {
  const decoder = new TextDecoder(); let buffer = "", total = 0;
  for await (const bytes of stream) {
    total += bytes.byteLength;
    if (total > 32 * 1024 * 1024) throw invalid("PROVIDER_STREAM_TOO_LARGE");
    buffer += decoder.decode(bytes, { stream: true });
    if (buffer.length > 4 * 1024 * 1024) throw invalid("PROVIDER_EVENT_TOO_LARGE");
    const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop();
    for (const event of events) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (data && data !== "[DONE]") yield JSON.parse(data);
  }
}
const wireEvent = (value) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);

/** Normalize native SSE into the common parser, retaining opaque reasoning
 * blocks only in provider-bound private continuation state (never UI deltas).
 * Tools are emitted only after the native terminal event has been received.
 */
export function normalizeNativeResponse(response, wire) {
  if (!response.ok || !response.body || !["responses", "anthropic-messages"].includes(wire.protocol)) return response;
  async function* normalize() {
    let terminal = false, started = false, content = "", usage = null, reason = null, finalItems = null;
    const blocks = new Map(), stopped = new Set(), responseItems = new Map();
    for await (const event of sseEvents(response.body)) {
      // Even thinking/ping activity resets the common parser's idle watchdog.
      yield wireEvent({ choices: [] });
      if (event.type === "error" || event.type === "response.failed") {
        const failure = event.error || event.response?.error || {};
        yield wireEvent({ error: { message: failure.message || failure.type || failure.code || "PROVIDER_NATIVE_ERROR" } }); return;
      }
      if (wire.protocol === "anthropic-messages") {
        if (event.type === "message_start") {
          if (started) throw invalid("PROVIDER_MESSAGE_SEQUENCE_INVALID");
          started = true; usage = event.message?.usage || null;
          yield wireEvent({ choices: [], usage });
        }
        if (event.type !== "ping" && !started) throw invalid("PROVIDER_MESSAGE_SEQUENCE_INVALID");
        if (event.type === "content_block_start") {
          if (!Number.isInteger(event.index) || event.index < 0 || event.index > 256 || blocks.has(event.index)) throw invalid("PROVIDER_BLOCK_INDEX_INVALID");
          const block = event.content_block;
          if (!["text", "thinking", "redacted_thinking", "tool_use"].includes(block?.type)) throw invalid("PROVIDER_NATIVE_BLOCK_UNSUPPORTED");
          blocks.set(event.index, { ...structuredClone(block), partialJson: "" });
          if (block.type === "text" && typeof block.text !== "string") throw invalid("PROVIDER_TEXT_INVALID");
          if (block.type === "text" && block.text) { content += block.text; yield wireEvent({ choices: [{ delta: { content: block.text } }] }); }
        }
        if (event.type === "content_block_delta") {
          const block = blocks.get(event.index), delta = event.delta || {};
          if (!block || stopped.has(event.index)) throw invalid("PROVIDER_BLOCK_SEQUENCE_INVALID");
          if (delta.type === "text_delta" && block.type === "text" && typeof delta.text === "string") { block.text = (block.text || "") + delta.text; content += delta.text; yield wireEvent({ choices: [{ delta: { content: delta.text } }] }); }
          else if (delta.type === "input_json_delta" && block.type === "tool_use" && typeof delta.partial_json === "string") block.partialJson += delta.partial_json;
          else if (delta.type === "thinking_delta" && block.type === "thinking" && typeof delta.thinking === "string") block.thinking = (block.thinking || "") + (delta.thinking || "");
          else if (delta.type === "signature_delta" && block.type === "thinking" && typeof delta.signature === "string") block.signature = (block.signature || "") + (delta.signature || "");
          else throw invalid("PROVIDER_BLOCK_DELTA_UNSUPPORTED");
        }
        if (event.type === "content_block_stop") {
          if (!blocks.has(event.index) || stopped.has(event.index)) throw invalid("PROVIDER_BLOCK_SEQUENCE_INVALID");
          stopped.add(event.index);
        }
        if (event.type === "message_delta") { reason = event.delta?.stop_reason ?? reason; usage = { ...(usage || {}), ...(event.usage || {}) }; yield wireEvent({ choices: [], usage }); }
        if (event.type === "message_stop") {
          terminal = true;
          if (stopped.size !== blocks.size || !reason) throw invalid("PROVIDER_STREAM_INCOMPLETE");
          finalItems = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => {
            const { partialJson, ...value } = block;
            if (value.type === "tool_use" && partialJson) {
              try { value.input = JSON.parse(partialJson); } catch { value.input = null; }
            }
            return value;
          });
        }
      } else {
        if (event.type === "response.output_text.delta") { if (typeof event.delta !== "string") throw invalid("PROVIDER_TEXT_INVALID"); content += event.delta || ""; yield wireEvent({ choices: [{ delta: { content: event.delta || "" } }] }); }
        if (event.type === "response.output_item.done") responseItems.set(event.output_index, event.item);
        if (["response.completed", "response.incomplete"].includes(event.type)) {
          terminal = true; const result = event.response;
          if (!result || (result.output !== undefined && !Array.isArray(result.output))) throw invalid("PROVIDER_STREAM_INCOMPLETE");
          usage = result.usage || null;
          finalItems = result.output || [...responseItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
          reason = event.type === "response.completed" ? "end_turn" : result.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : "unsupported_stop";
        }
      }
      // Completion is the protocol boundary; do not wait for a kept-alive socket.
      // Exiting the iterator also cancels the unread response body.
      if (terminal) break;
    }
    if (!terminal || !finalItems) throw invalid("PROVIDER_STREAM_INCOMPLETE");
    const calls = [];
    let finalText = "";
    if (wire.protocol === "anthropic-messages") {
      for (const block of finalItems) {
        if (block.type === "text") finalText += block.text || "";
        if (block.type === "tool_use") calls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) } });
        if (block.type === "thinking" && typeof block.signature !== "string") throw invalid("PROVIDER_THINKING_SIGNATURE_MISSING");
      }
    } else {
      for (const item of finalItems) {
        if (item.type === "function_call") calls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
        else if (item.type === "message") for (const part of item.content || []) {
          if (part.type === "output_text") finalText += part.text || "";
          else if (part.type === "refusal") { finalText += part.refusal || ""; reason = "refusal"; }
          else throw invalid("PROVIDER_NATIVE_OUTPUT_UNSUPPORTED");
        }
        else if (item.type !== "reasoning") throw invalid("PROVIDER_NATIVE_OUTPUT_UNSUPPORTED");
      }
    }
    if (!finalText.startsWith(content)) throw invalid("PROVIDER_TEXT_STREAM_MISMATCH");
    if (finalText.length > content.length) yield wireEvent({ choices: [{ delta: { content: finalText.slice(content.length) } }] });
    const message = { content: finalText, ...(calls.length ? { tool_calls: calls } : {}) };
    const finish = ["end_turn", "stop_sequence", "tool_use"].includes(reason) ? calls.length ? "tool_calls" : "stop" : reason === "max_tokens" ? "length" : "content_filter";
    const state = { version: 1, protocol: wire.protocol, binding: wire.binding, messageHash: hash(publicAssistant(message)), items: finalItems, outputTokens: Number(usage?.output_tokens ?? usage?.completion_tokens) || 0 };
    yield wireEvent({ choices: [{ delta: calls.length ? { tool_calls: calls.map((call, index) => ({ ...call, index })) } : {}, finish_reason: finish }], usage, aporia_native_state: state });
    yield new TextEncoder().encode("data: [DONE]\n\n");
  }
  const iterator = normalize();
  return new Response(new ReadableStream({
    async pull(controller) { try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); } catch (error) { controller.error(error); } },
    async cancel() { await iterator.return?.(); },
  }), { status: response.status, headers: { "content-type": "text/event-stream" } });
}

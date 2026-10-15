/** Pure response observer; opt-in diagnostics can observe existing parsed events.
 * Captures only provider-returned readable fields; never decrypts reasoning.
 * No network, retries, credentials, request bodies, or disk writes here.
 */
export function createResponseCapture({ protocol = 'deepseek-chat', requestId, attemptId, phaseId = null,
  maxChars = 2_000_000, now = () => Date.now() } = {}) {
  if (!['deepseek-chat', 'openai-chat', 'anthropic-messages', 'responses'].includes(protocol)) throw new Error('Unsupported capture protocol.');
  if (!requestId || !attemptId) throw new Error('Request and attempt identities are required.');
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('Invalid capture limit.');
  const events = [], blocks = new Map(), textParts = new Map(), reasoningParts = new Map();
  let chars = 0, status = 'receiving', finishReason = null, usage = null, error = null;
  let reasoning = '', output = '', opaqueBlocks = 0, truncated = false, eventsTruncated = false;
  const startedAt = now();
  const event = (kind, extra = {}) => {
    const value = { requestId, attemptId, phaseId, at: now(), kind, ...extra };
    // Keep bounded metadata, not raw provider payloads or duplicate text.
    if (events.length < 10_000) events.push(value); else eventsTruncated = true;
    return value;
  };
  const append = (kind, value) => {
    if (typeof value !== 'string' || !value) return '';
    let fragment = value.slice(0, Math.max(0, maxChars - chars));
    // Do not split UTF-16 surrogate pairs at the storage limit.
    if (/[\uD800-\uDBFF]$/.test(fragment)) fragment = fragment.slice(0, -1);
    chars += fragment.length;
    truncated ||= fragment.length < value.length;
    if (kind === 'thinking') reasoning += fragment; else output += fragment;
    event(kind, { receivedChars: value.length, storedChars: fragment.length });
    return fragment;
  };
  const fail = () => { status = 'failed'; error = 'PROVIDER_ERROR'; event('error'); };
  const complete = () => { if (status !== 'failed') { status = 'completed'; event('completed', { finishReason }); } };
  const tail = (map, key, value, kind) => {
    if (typeof value !== 'string') return;
    const previous = map.get(key) || { length: 0, prefix: '' };
    if (!value.startsWith(previous.prefix) || value.length < previous.length) throw new Error('Final response disagrees with streamed content.');
    const stored = append(kind, value.slice(previous.length));
    map.set(key, { length: value.length, prefix: previous.prefix + stored });
  };
  function accept(payload) {
    if (status !== 'receiving') return;
    if (payload === '[DONE]') {
      if (['deepseek-chat', 'openai-chat'].includes(protocol) && finishReason != null) complete();
      return;
    }
    if (!payload || typeof payload !== 'object') { event('keepalive'); return; }
    if (payload.error || ['error', 'response.failed'].includes(payload.type)) { fail(); return; }
    if (payload.usage && protocol !== 'anthropic-messages') usage = structuredClone(payload.usage);
    if (['deepseek-chat', 'openai-chat'].includes(protocol)) {
      const choice = payload.choices?.find(c => c.index === 0) || payload.choices?.[0];
      const delta = choice?.delta || choice?.message;
      if (typeof delta?.reasoning_content === 'string') append('thinking', delta.reasoning_content);
      if (typeof delta?.content === 'string') append('output', delta.content);
      if (delta?.tool_calls?.length) event('tool-call', { count: delta.tool_calls.length });
      if (choice?.finish_reason != null) { finishReason = choice.finish_reason; event('finish', { finishReason }); }
      if (!delta && choice?.finish_reason == null) event('keepalive');
      return;
    }
    if (protocol === 'anthropic-messages') {
      if (payload.type === 'message_start') usage = structuredClone(payload.message?.usage || {});
      if (payload.type === 'content_block_start') {
        const b = payload.content_block || {}; blocks.set(payload.index, b.type);
        if (b.type === 'thinking') append('thinking', b.thinking);
        if (b.type === 'text') append('output', b.text);
        if (b.type === 'redacted_thinking') { opaqueBlocks++; event('opaque-thinking'); }
        if (b.type === 'tool_use') event('tool-call');
      } else if (payload.type === 'content_block_delta') {
        const d = payload.delta || {};
        if (d.type === 'thinking_delta' && blocks.get(payload.index) === 'thinking') append('thinking', d.thinking);
        else if (d.type === 'text_delta' && blocks.get(payload.index) === 'text') append('output', d.text);
        else if (d.type === 'input_json_delta') event('tool-call-fragment');
        // Signatures and redacted data are intentionally not human-readable.
      } else if (payload.type === 'message_delta') {
        finishReason = payload.delta?.stop_reason ?? finishReason;
        usage = { ...(usage || {}), ...(payload.usage || {}) };
      } else if (payload.type === 'message_stop' && finishReason) complete();
      else if (payload.type === 'ping') event('keepalive');
      return;
    }
    const key = `${payload.output_index ?? 0}:${payload.content_index ?? payload.summary_index ?? 0}`;
    if (payload.type === 'response.output_text.delta') {
      const previous = textParts.get(key) || { length: 0, prefix: '' };
      const stored = append('output', payload.delta);
      textParts.set(key, { length: previous.length + (typeof payload.delta === 'string' ? payload.delta.length : 0), prefix: previous.prefix + stored });
    } else if (payload.type === 'response.reasoning_summary_text.delta') {
      const previous = reasoningParts.get(key) || { length: 0, prefix: '' };
      const stored = append('thinking', payload.delta);
      reasoningParts.set(key, { length: previous.length + (typeof payload.delta === 'string' ? payload.delta.length : 0), prefix: previous.prefix + stored });
    } else if (['response.completed', 'response.incomplete'].includes(payload.type)) {
      for (const [index, item] of (payload.response?.output || []).entries()) {
        if (item.type === 'reasoning') {
          if (item.encrypted_content) { opaqueBlocks++; event('opaque-thinking'); }
          for (const [part, s] of (item.summary || []).entries()) if (s.type === 'summary_text') tail(reasoningParts, `${index}:${part}`, s.text, 'thinking');
        }
        if (item.type === 'message') for (const [part, s] of (item.content || []).entries()) if (s.type === 'output_text') tail(textParts, `${index}:${part}`, s.text, 'output');
        if (item.type === 'function_call') event('tool-call');
      }
      usage = structuredClone(payload.response?.usage || usage);
      finishReason = payload.type === 'response.completed' ? 'stop' : payload.response?.incomplete_details?.reason || 'incomplete';
      if (payload.type === 'response.completed') complete();
      else { status = 'incomplete'; event('incomplete', { finishReason }); }
    } else event('activity');
  }
  return {
    accept,
    end({ interrupted = false } = {}) {
      if (status === 'receiving') { status = interrupted ? 'interrupted' : 'incomplete'; event(status); }
      return this.snapshot();
    },
    snapshot() {
      return structuredClone({ requestId, attemptId, phaseId, protocol, status, startedAt, finishReason, usage,
        error, reasoning, output, opaqueBlocks, truncated, eventsTruncated, events,
        reasoningSource: protocol === 'responses' ? 'provider-public-summary' : 'provider-readable-field' });
    },
  };
}

/** Streaming SSE decoder; handles split UTF-8, CRLF, and multiline data. */
export async function captureSse(chunks, options = {}) {
  const capture = createResponseCapture(options), decoder = new TextDecoder();
  const maxEventChars = options.maxEventChars ?? 2_000_000;
  if (!Number.isSafeInteger(maxEventChars) || maxEventChars < 1) throw new Error('Invalid SSE event limit.');
  let buffer = '', data = [];
  const dispatch = () => {
    if (!data.length) return;
    const raw = data.join('\n'); data = [];
    if (raw === '[DONE]') capture.accept(raw);
    else {
      let payload;
      try { payload = JSON.parse(raw); } catch { throw new Error('Malformed SSE JSON event.'); }
      capture.accept(payload);
    }
  };
  const line = value => {
    if (value === '') dispatch();
    else if (value.startsWith(':')) capture.accept(null);
    else if (value.startsWith('data:')) {
      data.push(value.slice(5).replace(/^ /, ''));
      if (data.reduce((sum, s) => sum + s.length, 0) > maxEventChars) throw new Error('SSE event exceeds capture limit.');
    }
  };
  try {
    for await (const chunk of chunks) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, i).replace(/\r$/, '')); buffer = buffer.slice(i + 1); }
      if (buffer.length > maxEventChars) throw new Error('SSE line exceeds capture limit.');
    }
    buffer += decoder.decode();
    if (buffer) line(buffer.replace(/\r$/, ''));
    dispatch();
    return capture.end();
  } catch (error) {
    // Never include raw event text (potential private content) in diagnostics.
    error.capture = capture.end({ interrupted: true });
    throw error;
  }
}

// Presentation metadata only. Never publish arguments, reasoning or partial
// actions, and never execute a tool before its terminal protocol boundary.
import { normalizeTokenUsage } from './token-usage.js';

export function createModelStreamProgress({ now = Date.now, intervalMs = 500, inputTokens = null } = {}) {
  const started = now(), names = new Map();
  let stage = 'waiting', generatedChars = 0, toolName = '', toolCount = 0, last = null, lastAt = -Infinity;
  let outputWeight = 0, actualInput = false, actualOutput = false;
  const addText = value => {
    if (typeof value !== 'string' || !value) return 0;
    // Chunk-independent heuristic. No argument or private reasoning text is kept.
    for (const char of value) outputWeight += /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(char) ? 1 : 0.28;
    actualOutput = false;
    return value.length;
  };
  const safeName = value => typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,119}$/.test(value) ? value : '';
  function publish(nextStage, count = 0, name = '', force = false) {
    generatedChars += Math.max(0, count);
    stage = nextStage; toolName = safeName(name);
    const key = `${stage}:${toolName}:${generatedChars > 0}`;
    if (!force && key === last && now() - lastAt < intervalMs) return null;
    last = key; lastAt = now();
    return { stage, generatedChars, toolName, toolCount, elapsedMs: Math.max(0, now() - started), inputTokens, outputTokens: Math.ceil(outputWeight), inputTokensEstimated: !actualInput, outputTokensEstimated: !actualOutput };
  }
  function native(event) {
    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const name = safeName(event.item.name); names.set(event.output_index, name); toolCount++;
      return publish('tool-arguments', 0, name);
    }
    if (event.type === 'response.function_call_arguments.delta') return publish('tool-arguments', addText(event.delta), names.get(event.output_index));
    if (event.type === 'response.output_text.delta') return publish('text', addText(event.delta));
    if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') return publish('receiving', addText(event.delta));
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const name = safeName(event.content_block.name); names.set(event.index, name); toolCount++;
      return publish('tool-arguments', 0, name);
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') return publish('tool-arguments', addText(event.delta.partial_json), names.get(event.index));
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') return publish('text', addText(event.delta.text));
    if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') return publish('receiving', addText(event.delta.thinking));
    if (['response.completed', 'response.incomplete', 'message_stop'].includes(event.type)) return null;
    return stage === 'waiting' ? publish('receiving') : null;
  }
  function chat(delta) {
    if (delta?.tool_calls?.length) {
      let count = 0, name = '';
      for (const call of delta.tool_calls) {
        if (!names.has(call.index)) { names.set(call.index, ''); toolCount++; }
        if (safeName(call.function?.name)) names.set(call.index, safeName(call.function.name));
        count += addText(call.function?.arguments); name = names.get(call.index);
      }
      return publish('tool-arguments', count, name);
    }
    if (delta?.content) return publish('text', addText(delta.content));
    if (delta?.reasoning_content) return publish('receiving', addText(delta.reasoning_content));
    return null;
  }
  function reportUsage(usage, { final = false } = {}) {
    const normalized = normalizeTokenUsage(usage);
    if (!normalized) return null;
    const has = keys => keys.some(key => usage[key] != null && Number.isFinite(Number(usage[key])));
    if (has(['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'])) { inputTokens = normalized.prompt_tokens; actualInput = true; }
    if (has(['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'])) {
      outputWeight = normalized.completion_tokens; actualOutput = final;
    }
    return publish(stage, 0, toolName, true);
  }
  function receiveNative(metadata) {
    generatedChars = metadata.generatedChars;
    outputWeight = metadata.outputTokens;
    actualOutput = false;
    return publish(metadata.stage, 0, metadata.toolName);
  }
  return { native, chat, reportUsage, receiveNative, flush: () => publish(stage, 0, toolName, true), waiting: () => publish('waiting') };
}

// Responses deltas belong to (output item, content part), not a single string.
// Validate each part against its own final value before reconciling display order.
// A terminal event is still mandatory; no tool is reconstructed from fragments.
const invalid = code => Object.assign(new Error(code), { code, retryable: false });
const index = value => {
  if (value === undefined) return 0; // Older compatible endpoints omit indices.
  if (!Number.isInteger(value) || value < 0 || value > 4096) throw invalid('PROVIDER_BLOCK_INDEX_INVALID');
  return value;
};
export function createResponsesTextState() {
  const parts = new Map(), itemIds = new Map(), idIndices = new Map(), completed = new Map(), sequences = new Map();
  function bind(outputIndex, id) {
    if (id === undefined) return;
    if (typeof id !== 'string' || !id || (itemIds.has(outputIndex) && itemIds.get(outputIndex) !== id) || (idIndices.has(id) && idIndices.get(id) !== outputIndex))
      throw invalid('PROVIDER_ITEM_ID_MISMATCH');
    itemIds.set(outputIndex, id); idIndices.set(id, outputIndex);
  }
  function part(outputIndex, contentIndex) {
    const key = `${outputIndex}:${contentIndex}`;
    if (!parts.has(key)) parts.set(key, { outputIndex, contentIndex, delta: '', final: undefined });
    return parts.get(key);
  }
  function finish(outputIndex, contentIndex, text) {
    if (typeof text !== 'string') throw invalid('PROVIDER_TEXT_INVALID');
    const value = part(outputIndex, contentIndex);
    if (!text.startsWith(value.delta) || (value.final !== undefined && value.final !== text)) throw invalid('PROVIDER_TEXT_STREAM_MISMATCH');
    value.final = text;
  }
  function accept(event) {
    if (!['response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.added', 'response.output_item.done'].includes(event.type)) return true;
    if (event.sequence_number !== undefined) {
      const sequence = event.sequence_number;
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw invalid('PROVIDER_MESSAGE_SEQUENCE_INVALID');
      const signature = JSON.stringify(event);
      if (sequences.has(sequence)) {
        if (sequences.get(sequence) !== signature) throw invalid('PROVIDER_MESSAGE_SEQUENCE_INVALID');
        return false; // Identical repeated transport event, not another token.
      }
      if (sequences.size >= 100_000) throw invalid('PROVIDER_STREAM_TOO_LARGE');
      sequences.set(sequence, signature);
    }
    const outputIndex = index(event.output_index);
    bind(outputIndex, event.item_id ?? event.item?.id);
    if (event.type === 'response.output_text.delta') {
      if (typeof event.delta !== 'string') throw invalid('PROVIDER_TEXT_INVALID');
      const value = part(outputIndex, index(event.content_index));
      value.delta += event.delta;
      if (value.final !== undefined && !value.final.startsWith(value.delta)) throw invalid('PROVIDER_TEXT_STREAM_MISMATCH');
    } else if (event.type === 'response.output_text.done') finish(outputIndex, index(event.content_index), event.text);
    else if (event.type === 'response.content_part.done' && event.part?.type === 'output_text') finish(outputIndex, index(event.content_index), event.part.text);
    else if (event.type === 'response.output_item.done') {
      const item = event.item;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid('PROVIDER_NATIVE_OUTPUT_UNSUPPORTED');
      const previous = completed.get(outputIndex);
      if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw invalid('PROVIDER_ITEM_FINAL_MISMATCH');
      if (item.type === 'message') for (const [contentIndex, value] of (item.content || []).entries()) {
        if (value.type === 'output_text') finish(outputIndex, contentIndex, value.text);
      }
      completed.set(outputIndex, structuredClone(item));
    }
    return true;
  }
  function finalize(result) {
    if (!result || (result.output !== undefined && !Array.isArray(result.output))) throw invalid('PROVIDER_STREAM_INCOMPLETE');
    // Some compatible servers send an empty terminal summary after complete
    // output_item.done events. Those completed items are sufficient evidence;
    // text deltas or tool-argument fragments alone are never sufficient.
    const terminalItems = result.output?.length ? result.output.entries() : [...completed.entries()].sort(([a], [b]) => a - b);
    const byIndex = new Map(), finalIds = new Set();
    for (const [position, item] of terminalItems) {
      if (!item || typeof item !== 'object') throw invalid('PROVIDER_NATIVE_OUTPUT_UNSUPPORTED');
      if (item.id && finalIds.has(item.id)) throw invalid('PROVIDER_ITEM_ID_MISMATCH');
      if (item.id) finalIds.add(item.id);
      const outputIndex = item.id && idIndices.has(item.id) ? idIndices.get(item.id) : position;
      bind(outputIndex, item.id);
      if (byIndex.has(outputIndex)) throw invalid('PROVIDER_ITEM_ID_MISMATCH');
      const previous = completed.get(outputIndex);
      if (previous && previous.type !== item.type) throw invalid('PROVIDER_ITEM_FINAL_MISMATCH');
      if (previous?.type === 'function_call' && ['type', 'call_id', 'name', 'arguments', 'namespace'].some(key => previous[key] !== item[key])) throw invalid('PROVIDER_ITEM_FINAL_MISMATCH');
      byIndex.set(outputIndex, item);
      if (item.type === 'message') for (const [contentIndex, value] of (item.content || []).entries()) {
        if (value.type === 'output_text') finish(outputIndex, contentIndex, value.text);
      }
    }
    for (const value of parts.values()) {
      const finalPart = byIndex.get(value.outputIndex)?.content?.[value.contentIndex];
      if (finalPart?.type !== 'output_text' || typeof finalPart.text !== 'string') throw invalid('PROVIDER_TEXT_STREAM_MISMATCH');
      finish(value.outputIndex, value.contentIndex, finalPart.text);
    }
    return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, item]) => structuredClone(item));
  }
  return { accept, finalize };
}

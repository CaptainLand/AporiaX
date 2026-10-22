const OUTCOMES = new Set(["completed", "partial", "blocked", "needs_input"]);

const STATUS_ALIASES = { done: 'completed', complete: 'completed', success: 'completed',
  failed: 'partial', failure: 'partial', error: 'partial', incomplete: 'partial',
  needs_user_input: 'needs_input', waiting_for_user: 'needs_input' };
const text = value => typeof value === 'string' ? value.trim() : Array.isArray(value)
  ? value.map(item => typeof item === 'string' ? item : item?.type === 'text' ? item.text : '').filter(item => typeof item === 'string' && item.trim()).join('\n\n').trim() : '';

// Optional presentation metadata. A malformed wrapper must never discard a
// usable answer or turn completed file operations into a failed runtime.
export function readTaskOutcome(message, parseArguments) {
  const calls = message?.tool_calls || [];
  const finish = calls.find((call) => call.function?.name === "finish_task");
  if (!finish) return null;
  let input = {}, issues = [];
  try {
    const parsed = parseArguments(finish);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
    else issues.push('arguments_not_object');
  } catch { issues.push('arguments_not_json'); }
  const rawStatus = typeof input.status === 'string' ? input.status.trim().toLowerCase() : '';
  const status = OUTCOMES.has(rawStatus) ? rawStatus : Object.hasOwn(STATUS_ALIASES, rawStatus) ? STATUS_ALIASES[rawStatus] : 'completed';
  if (rawStatus !== status) issues.push(rawStatus ? 'status_normalized' : 'status_omitted');
  const summary = text(input.summary) || text(message.content) || text(input.answer) || text(input.response) || text(input.content) || text(input.message);
  if (!text(input.summary)) issues.push(summary ? 'answer_used_as_summary' : 'answer_missing');
  const extras = {};
  for (const key of ['details', 'limitations', 'warnings']) {
    if (text(input[key])) extras[key] = text(input[key]);
    else if (input[key] !== undefined) issues.push(`${key}_omitted`);
  }
  return { status, summary, ...extras,
    ...(calls.some(call => call.function?.name !== 'finish_task') ? { deferred: true } : {}),
    ...(issues.length ? { normalization: { issues } } : {}),
  };
}

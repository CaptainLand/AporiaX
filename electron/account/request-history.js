// A read-only, fixed-path bridge. Never forward arbitrary renderer query fields
// or upstream payloads (which may grow to include private request content).
const cursorPattern = /^[A-Za-z0-9_-]{1,400}$/;
const text = (value, max = 160) => typeof value === 'string' ? value.slice(0, max) : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function historyQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['accountId', 'cursor'].includes(key))
    || typeof input.accountId !== 'string' || !input.accountId || input.accountId.length > 160
    || (input.cursor != null && (typeof input.cursor !== 'string' || !cursorPattern.test(input.cursor)))) {
    throw new Error('ACCOUNT_HISTORY_QUERY_INVALID');
  }
  const query = new URLSearchParams({ days: 'all', status: 'all', limit: '100' });
  if (input.cursor) query.set('cursor', input.cursor);
  return `/usage/requests?${query}`;
}

export function projectRequestHistory(payload) {
  if (!Array.isArray(payload?.items) || payload.items.length > 100 || !date(payload.sampledAt)
    || (payload.nextCursor != null && (typeof payload.nextCursor !== 'string' || !cursorPattern.test(payload.nextCursor)))) {
    throw new Error('ACCOUNT_HISTORY_RESPONSE_INVALID');
  }
  const items = payload.items.map(row => {
    if (!row || typeof row.requestId !== 'string' || !row.requestId || row.requestId.length > 160 || !date(row.startedAt)
      || !['settled', 'processing', 'pending', 'unbilled'].includes(row.billingStatus)) throw new Error('ACCOUNT_HISTORY_RESPONSE_INVALID');
    const settled = row.billingStatus === 'settled';
    const input = number(row.tokens?.input), output = number(row.tokens?.output);
    return {
      requestId: row.requestId, startedAt: date(row.startedAt), settledAt: date(row.settledAt),
      model: text(row.model), modelSlug: text(row.modelSlug), deviceName: text(row.deviceName),
      billingStatus: row.billingStatus, billingSource: row.billingSource === 'weekly' ? 'weekly' : 'other',
      quotaUsedRatio: settled && row.billingSource === 'weekly' ? number(row.quotaUsedRatio) : null,
      tokens: settled ? { input, output, cachedInput: number(row.tokens?.cachedInput), total: input != null && output != null ? input + output : null } : null,
      responseTimeMs: number(row.responseTimeMs),
      status: ['failed', 'completed', 'interrupted', 'interrupted-quota'].includes(row.status) ? row.status : null,
      finishReason: ['stop', 'tool_calls', 'length', 'content_filter'].includes(row.finishReason) ? row.finishReason : null,
      errorCode: typeof row.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(row.errorCode) ? row.errorCode : null,
    };
  });
  if (payload.nextCursor && !items.length) throw new Error('ACCOUNT_HISTORY_RESPONSE_INVALID');
  return { items, nextCursor: payload.nextCursor || null, sampledAt: date(payload.sampledAt) };
}

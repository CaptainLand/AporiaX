const RECORD_LIMIT = 500;
const active = new Set(['running', 'waiting', 'paused']);
const number = value => Math.max(0, Number(value) || 0);

// Presentation only: each underlying attempt keeps its own unmodified audit
// snapshot. Namespace local record IDs before displaying them on one timeline.
export function continueWitness(previous, current, runId, { recovered = false } = {}) {
  if (!current) return previous;
  if (!previous && !recovered) return current;
  const earlier = (previous?.records || []).map(record => active.has(record.status)
    ? { ...record, status: 'interrupted' } : record);
  const next = (current.records || []).map(record => ({ ...record, id: `${runId}:${record.id}`, witnessRunId: runId,
    ...(recovered && active.has(record.status) ? { status: 'interrupted' } : {}) }));
  const records = [...earlier, ...next];
  const counters = { ...current.counters };
  if (previous) for (const key of ['completedActions', 'failedActions'])
    counters[key] = number(previous.counters?.[key]) + number(current.counters?.[key]);
  return { ...current, continued: Boolean(previous), records: records.slice(-RECORD_LIMIT),
    current: current.current ? next.find(record => record.id === `${runId}:${current.current.id}`) || null : null,
    startedAt: previous?.startedAt || current.startedAt,
    previousElapsedMs: number(previous?.elapsedMs),
    elapsedMs: number(previous?.elapsedMs) + number(current.elapsedMs),
    omittedRecords: number(previous?.omittedRecords) + number(current.omittedRecords) + Math.max(0, records.length - RECORD_LIMIT),
    counters,
  };
}

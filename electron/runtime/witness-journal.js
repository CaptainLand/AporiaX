export const WITNESS_DELTA_EVENT = 'witness.delta';

const clock = (startedAt, endedAt) => {
  const elapsed = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : undefined;
};
const equal = (a, b) => a === b || (
  a != null && b != null && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b)
);

function recordElapsed(record, updatedAt) {
  return clock(record.startedAt, record.completedAt || updatedAt);
}

function withoutElapsed(record, updatedAt) {
  if (record.elapsedMs !== undefined && record.elapsedMs === recordElapsed(record, updatedAt)) {
    const { elapsedMs, ...rest } = record;
    return rest;
  }
  return record;
}

function sameRecord(before, after, previousAt, updatedAt) {
  if (!before) return false;
  const keys = Object.keys(after);
  return keys.length === Object.keys(before).length && keys.every(key => equal(before[key], after[key]) || (
    key === 'elapsedMs' && !before.completedAt && !after.completedAt &&
    before.elapsedMs === recordElapsed(before, previousAt) && after.elapsedMs === recordElapsed(after, updatedAt)
  ));
}

// This codec is only for the journal. The desktop and live subscribers still
// receive exactly the same Witness snapshots as before.
export function createWitnessJournalWriter() {
  let previous = new Map(), metaByKey = new Map(), currentKey, previousAt;
  let initialized = false;
  return event => {
    if (event.type !== 'witness.updated') return event;
    const reset = () => {
      initialized = false;
      previous = new Map(); metaByKey = new Map(); currentKey = previousAt = undefined;
      return event;
    };
    if (!Array.isArray(event.witness?.records)) return reset();
    const { witness, ...envelope } = event;
    const { records, current, revision, updatedAt, elapsedMs, ...metadata } = witness;
    const next = new Map(records.map(record => [record.id, record]));
    if (next.size !== records.length || records.some(record => typeof record.id !== 'string' || !record.id)) return reset();
    if (elapsedMs !== undefined && elapsedMs !== clock(metadata.startedAt, updatedAt)) metadata.elapsedMs = elapsedMs;
    const nextMeta = new Map(Object.entries(metadata).map(([key, value]) => [key, JSON.stringify(value)]));
    const set = Object.fromEntries(Object.entries(metadata).filter(([key]) => metaByKey.get(key) !== nextMeta.get(key)));
    const unset = [...metaByKey.keys()].filter(key => !nextMeta.has(key));
    const upsert = records.filter(record => !sameRecord(previous.get(record.id), record, previousAt, updatedAt))
      .map(record => withoutElapsed(record, updatedAt));
    const remove = [...previous.keys()].filter(id => !next.has(id));
    const ids = [...next.keys()];
    const expectedOrder = [...previous.keys()].filter(id => next.has(id)).concat(ids.filter(id => !previous.has(id)));
    const order = ids.some((id, index) => id !== expectedOrder[index]) ? ids : null;
    const projectedCurrent = current == null ? null : next.has(current.id) ? current.id : current;
    const nextCurrent = JSON.stringify(projectedCurrent);
    const currentChanged = nextCurrent !== currentKey;
    if (initialized && !upsert.length && !remove.length && !order && !Object.keys(set).length && !unset.length && !currentChanged) return null;

    const delta = { version: 1, ...(initialized ? {} : { start: true }), revision, updatedAt,
      ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}),
      ...(upsert.length ? { upsert } : {}), ...(remove.length ? { remove } : {}), ...(order ? { order } : {}),
      ...(currentChanged ? { current: projectedCurrent } : {}) };
    initialized = true; previous = next; previousAt = updatedAt; metaByKey = nextMeta; currentKey = nextCurrent;
    return { ...envelope, type: WITNESS_DELTA_EVENT, witnessDelta: delta };
  };
}

export function createWitnessJournalReader(legacy = null) {
  let records, metadata, current, revision, updatedAt;
  let started = false;
  const reset = () => {
    records = new Map(); metadata = Object.create(null); current = null; revision = updatedAt = undefined;
  };
  reset();
  return {
    apply(delta) {
      if (delta?.version !== 1 || (!started && !delta.start)) return false;
      if (delta.start) reset();
      started = true;
      for (const key of delta.unset || []) delete metadata[key];
      Object.assign(metadata, delta.set);
      for (const id of delta.remove || []) records.delete(id);
      for (const record of delta.upsert || []) records.set(record.id, record);
      if (delta.order) records = new Map(delta.order.map(id => [id, records.get(id)]).filter(([, value]) => value));
      if ('current' in delta) current = delta.current;
      revision = delta.revision; updatedAt = delta.updatedAt;
      return true;
    },
    snapshot() {
      if (!started) return legacy;
      const projected = [...records.values()].map(record => {
        const elapsedMs = recordElapsed(record, updatedAt);
        return elapsedMs === undefined || record.elapsedMs !== undefined ? record : { ...record, elapsedMs };
      });
      const elapsedMs = metadata.elapsedMs ?? clock(metadata.startedAt, updatedAt);
      return { ...metadata, ...(revision === undefined ? {} : { revision }), ...(updatedAt === undefined ? {} : { updatedAt }),
        ...(elapsedMs === undefined ? {} : { elapsedMs }), records: projected,
        current: typeof current === 'string' ? projected.find(record => record.id === current) || null : current };
    },
  };
}

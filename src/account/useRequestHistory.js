import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeUsageRows } from './usage-model.js';

const empty = () => ({ rows: [], nextCursor: null, loaded: false, sampledAt: null, complete: false, error: '', busy: false });
export function useRequestHistory(api, accountId) {
  const [state, setState] = useState(empty);
  const current = useRef(state), generation = useRef(0), busy = useRef(false);
  const load = useCallback(async (reset = false, batch = false) => {
    if (!accountId || busy.current) return;
    const version = ++generation.current;
    busy.current = true;
    let data = reset ? empty() : current.current;
    data = { ...data, busy: true, error: '' };
    current.current = data; setState(data);
    try {
      if (!api?.getRequestHistory) throw new Error('ACCOUNT_HISTORY_UNAVAILABLE');
      const cursors = new Set();
      // Explicit synchronization is bounded; a large account can continue in batches.
      for (let page = 0; page < (batch ? 20 : 1); page++) {
        const cursor = data.nextCursor;
        if (cursors.has(cursor)) throw new Error('ACCOUNT_HISTORY_CURSOR_LOOP');
        cursors.add(cursor);
        const result = await api.getRequestHistory({ accountId, cursor });
        if (version !== generation.current) return;
        if (!Array.isArray(result?.items) || !Number.isFinite(Date.parse(result.sampledAt))
          || (result.nextCursor && result.nextCursor === cursor)) throw new Error('ACCOUNT_HISTORY_RESPONSE_INVALID');
        data = { ...data, rows: mergeUsageRows(data.rows, result.items), nextCursor: result.nextCursor,
          loaded: true, complete: !result.nextCursor, sampledAt: data.sampledAt || result.sampledAt };
        current.current = data; setState(data);
        if (data.complete || data.rows.length >= 10000) break;
      }
    } catch (error) {
      if (version !== generation.current) return;
      data = { ...data, error: String(error?.message || '').includes('UNAVAILABLE') ? 'unavailable' : 'failed' };
    } finally {
      if (version === generation.current) {
        busy.current = false; data = { ...data, busy: false }; current.current = data; setState(data);
      }
    }
  }, [api, accountId]);
  const stop = useCallback(() => {
    generation.current++; busy.current = false;
    current.current = { ...current.current, busy: false }; setState(current.current);
  }, []);
  useEffect(() => {
    generation.current++; busy.current = false; current.current = empty(); setState(current.current);
    if (accountId) void load(true);
    return () => { generation.current++; busy.current = false; };
  }, [load, accountId]);
  return { ...state, refresh: () => load(true), sync: () => load(false, true), more: () => load(), stop };
}

// One FIFO per desktop account runtime, shared by Main, Builders and vision.
// A slot lasts until the response BODY ends, not merely until headers arrive.
export function createCloudModelQueue() {
  let active = 0;
  const pending = [];
  const notify = (fn, value) => { try { fn?.(value); } catch { /* UI cannot break transport. */ } };
  const abortError = signal => signal?.reason || new DOMException('Aborted', 'AbortError');
  function pump() {
    while (pending.length) {
      const next = pending[0];
      const limits = next.getLimits() || {};
      const values = [limits.perUser, limits.perDevice, limits.global].filter(v => Number.isSafeInteger(v) && v > 0);
      const limit = values.length ? Math.min(...values) : 1;
      if (active >= limit) return;
      pending.shift(); next.signal?.removeEventListener('abort', next.abort);
      active++;
      let released = false;
      const release = () => { if (!released) { released = true; active--; pump(); } };
      if (next.queued) notify(next.onQueue, { state: 'admitted', source: 'desktop', limit, waitedMs: Date.now() - next.started });
      next.resolve(release);
    }
  }
  async function acquire({ signal, getLimits, onQueue }) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry = { signal, getLimits, onQueue, resolve, reject, started: Date.now(), queued: false };
      entry.abort = () => { const index = pending.indexOf(entry); if (index >= 0) pending.splice(index, 1); reject(abortError(signal)); pump(); };
      signal?.addEventListener('abort', entry.abort, { once: true });
      pending.push(entry); pump();
      if (pending.includes(entry)) {
        entry.queued = true;
        const limits = getLimits() || {};
        const values = [limits.perUser, limits.perDevice, limits.global].filter(v => Number.isSafeInteger(v) && v > 0);
        notify(onQueue, { state: 'queued', source: 'desktop', limit: values.length ? Math.min(...values) : 1, position: pending.indexOf(entry) + 1 });
      }
    });
  }
  return {
    snapshot: () => ({ active, queued: pending.length }),
    async run(fetchResponse, options) {
      const release = await acquire(options);
      try {
        options.signal?.throwIfAborted();
        const response = await fetchResponse();
        if (!response.body) { release(); return response; }
        const reader = response.body.getReader();
        let ended = false;
        const finish = () => { if (!ended) { ended = true; options.signal?.removeEventListener('abort', abort); release(); } };
        const abort = () => { void reader.cancel(options.signal?.reason).catch(() => {}); finish(); };
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) { abort(); throw abortError(options.signal); }
        const stream = new ReadableStream({
          async pull(controller) {
            try { const next = await reader.read(); if (next.done) { finish(); controller.close(); } else controller.enqueue(next.value); }
            catch (error) { finish(); controller.error(error); }
          },
          async cancel(reason) { try { await reader.cancel(reason); } finally { finish(); } },
        }, { highWaterMark: 0 });
        return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) { release(); throw error; }
    },
  };
}

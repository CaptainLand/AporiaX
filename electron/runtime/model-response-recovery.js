export const MODEL_NO_DATA_MS = 180_000;
export const MODEL_RECOVERY_ATTEMPTS = 3;

// A transport heartbeat is deliberately not accepted by this API.
export function createModelResponseRecovery({ now = Date.now, intervalMs = MODEL_NO_DATA_MS,
  initialAttempts = 0, responseId = '', connection = 'open', signal,
  isPaused = () => false, onState = () => {}, onAttempt = async () => ({ disposition: 'unsupported' }),
  onSafeRetry = () => false, onError = () => {}, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let attempts = Math.min(MODEL_RECOVERY_ATTEMPTS, Math.max(0, Number(initialAttempts) || 0));
  let lastProgress = now(), nextCheckAt = lastProgress + intervalMs, epoch = 0, timer = null, probe = null, disposed = false, queued = false;
  let state = attempts === MODEL_RECOVERY_ATTEMPTS ? 'waiting' : 'receiving';
  let tail = Promise.resolve();
  const snapshot = () => ({ responseId, state, attempt: attempts, maxAttempts: MODEL_RECOVERY_ATTEMPTS,
    idleMs: Math.max(0, now() - lastProgress), connection });
  const publish = disposition => {
    const event = { ...snapshot(), ...(disposition ? { disposition } : {}) };
    tail = tail.then(() => onState(event));
    tail.catch(error => { if (!disposed) onError(error); });
    return tail;
  };
  const cancelTimer = () => { if (timer != null) clearTimeoutFn(timer); timer = null; };
  function schedule(ms = intervalMs) {
    cancelTimer();
    if (disposed || queued || attempts >= MODEL_RECOVERY_ATTEMPTS) return;
    timer = setTimeoutFn(() => { timer = null; void check().catch(onError); }, Math.max(1, ms));
    timer?.unref?.();
  }
  async function check() {
    if (disposed || signal?.aborted || queued) return;
    if (isPaused()) { schedule(1000); return; }
    const remaining = nextCheckAt - now();
    if (remaining > 0) { schedule(remaining); return; }
    if (attempts >= MODEL_RECOVERY_ATTEMPTS) return;
    attempts++;
    state = 'checking';
    const generation = epoch;
    const currentProbe = new AbortController(); probe = currentProbe;
    await publish();
    if (disposed || generation !== epoch || currentProbe.signal.aborted) return;
    let result;
    try { result = await onAttempt({ ...snapshot(), signal: currentProbe.signal }); }
    catch { result = { disposition: 'unavailable' }; }
    if (probe === currentProbe) probe = null;
    if (disposed || generation !== epoch || signal?.aborted) return;
    state = 'waiting';
    await publish(result?.disposition || 'unavailable');
    if (disposed || generation !== epoch || signal?.aborted) return;
    if (result?.safeRetry === true && onSafeRetry(result) !== false) return;
    // Separate checks by a full inactivity window; the third leaves the stream
    // alive without another timer. No deadline is imposed on total thinking.
    nextCheckAt = now() + intervalMs;
    schedule();
  }
  const api = {
    snapshot,
    flush: () => tail,
    noteProgress() {
      if (disposed) return;
      epoch++; probe?.abort(); probe = null;
      const hadRecovery = attempts > 0;
      attempts = 0; lastProgress = now(); nextCheckAt = lastProgress + intervalMs; state = 'receiving';
      if (hadRecovery) void publish('resumed');
      schedule();
    },
    setQueued(value) {
      const next = value === true;
      if (queued === next) return;
      queued = next;
      cancelTimer();
      if (!queued) { lastProgress = now(); nextCheckAt = lastProgress + intervalMs; schedule(); }
    },
    retryChecks() {
      if (disposed) return;
      epoch++; probe?.abort(); probe = null;
      attempts = 0; state = 'receiving'; nextCheckAt = now();
      schedule(1);
    },
    dispose() { disposed = true; epoch++; cancelTimer(); probe?.abort(); signal?.removeEventListener('abort', api.dispose); },
  };
  signal?.addEventListener('abort', api.dispose, { once: true });
  if (signal?.aborted) api.dispose();
  else if (attempts === MODEL_RECOVERY_ATTEMPTS) void publish();
  else schedule();
  return api;
}

export async function probeModelRequest(provider, requestId, signal) {
  if (provider.kind !== 'aporia-cloud' || typeof provider.authenticatedFetch !== 'function' ||
      !/^[a-f0-9-]{36}$/i.test(requestId || '')) return { disposition: 'unsupported' };
  const response = await provider.authenticatedFetch(`/v1/requests/${encodeURIComponent(requestId)}`, {
    method: 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) { await response.body?.cancel(); return { disposition: 'unavailable' }; }
  const payload = await response.json(), receipt = payload?.request || payload;
  if (receipt?.requestId !== requestId) return { disposition: 'unavailable' };
  if (receipt.usageState === 'not-dispatched' && receipt.billing === 'released' && receipt.chargedMicros === 0)
    return { disposition: 'not-dispatched', safeRetry: true, requestId };
  return { disposition: ['provider', 'reconciled'].includes(receipt.usageState) ? 'result-unavailable' : 'in-flight' };
}

// Only the user may end an exhausted recovery wait. No tools are returned from
// an incomplete stream, and no new inference is dispatched by this function.
export function waitForModelRecovery({ error, control, signal, onState, intervalMs, now }) {
  return new Promise((resolve, reject) => {
    let watcher, unsubscribe, done = false, awaitingUser = false;
    const finish = (err, value) => {
      if (done) return; done = true;
      watcher?.dispose(); unsubscribe?.(); signal?.removeEventListener('abort', abort);
      err ? reject(err) : resolve(value);
    };
    const abort = () => finish(Object.assign(new Error('The task was stopped.'), { name: 'AbortError' }));
    watcher = createModelResponseRecovery({ intervalMs, now: now || (() => control.activeNow()), signal,
      initialAttempts: error.modelResponseRecovery?.attempt, responseId: error.modelResponseRecovery?.responseId,
      connection: 'closed', isPaused: () => control.paused,
      onAttempt: input => error.recoverModelConnection?.(input.signal) || { disposition: 'unsupported' },
      onState: async state => {
        await onState(state);
        if (!done && state.state === 'waiting' && state.attempt >= MODEL_RECOVERY_ATTEMPTS) {
          awaitingUser = true; control.pause('model-response'); await control.flush();
        }
      },
      onSafeRetry: result => {
        if (error.modelResponseRecovery?.receivedModelData || error.partialMessage?.content || error.partialToolCalls) return false;
        finish(null, result);
        control.resume('model-response');
        return true;
      }, onError: err => finish(err),
    });
    unsubscribe = control.onChange(state => {
      if (awaitingUser && !state.pauseReasons.includes('model-response')) {
        awaitingUser = false; watcher.retryChecks();
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

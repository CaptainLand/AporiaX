const interrupted = () => Object.assign(new Error("The task was stopped."), { name: "AbortError" });

// One controller per run, shared by Main, workers and the admission queue.
// Pausing blocks NEW work; only environment suspension cancels inference.
export function createRunControl({ now = Date.now, networkRetryMs = 15_000 } = {}) {
  const reasons = new Set(), listeners = new Set(), steeringListeners = new Set();
  const steeringQueue = [];
  let stopped = false, online = true, retryTimer = null, failures = 0;
  let pausedAt = null, pausedMs = 0, durableTail = Promise.resolve();
  const snapshot = () => ({ paused: reasons.size > 0, pauseReasons: [...reasons],
    pendingSteering: [...steeringQueue], pausedMs: pausedMs + (pausedAt == null ? 0 : now() - pausedAt) });
  const notify = () => {
    const state = snapshot();
    for (const listener of listeners) {
      try {
        const pending = listener(state);
        if (pending?.then) durableTail = Promise.all([durableTail, pending]).then(() => undefined);
      } catch (error) { durableTail = Promise.reject(error); }
    }
    // The gate rethrows storage errors before any subsequent work.
    durableTail.catch(() => {});
  };
  const change = (reason, enabled) => {
    if (stopped || reasons.has(reason) === enabled) return false;
    if (enabled) {
      if (!reasons.size) pausedAt = now();
      reasons.add(reason);
    } else {
      reasons.delete(reason);
      if (!reasons.size && pausedAt != null) { pausedMs += now() - pausedAt; pausedAt = null; }
    }
    notify();
    return true;
  };
  const clearRetry = () => { clearTimeout(retryTimer); retryTimer = null; };
  const retryNetwork = () => {
    if (stopped || !online || reasons.has("sleep")) return false;
    clearRetry();
    return change("network", false);
  };
  const api = {
    get paused() { return reasons.size > 0; },
    get environmentPaused() { return reasons.has("sleep") || reasons.has("network"); },
    snapshot,
    activeNow: () => now() - pausedMs - (pausedAt == null ? 0 : now() - pausedAt),
    flush: () => durableTail,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    pause: (reason = "user") => change(reason, true),
    resume: (reason = "user") => change(reason, false),
    retryNetwork,
    setOnline(value) {
      const wasOnline = online;
      online = value !== false;
      if (!online) { clearRetry(); change("network", true); }
      else if (!wasOnline) retryNetwork();
    },
    suspend() { clearRetry(); change("sleep", true); },
    wake(value = online) {
      online = value !== false;
      if (!online) change("network", true);
      change("sleep", false);
      if (online) retryNetwork();
    },
    waitForNetwork() {
      change("network", true);
      if (!stopped && online && !reasons.has("sleep") && !retryTimer) {
        const delay = Math.min(60_000, networkRetryMs * 2 ** Math.min(failures++, 3));
        retryTimer = setTimeout(retryNetwork, delay);
      }
    },
    networkSucceeded() { failures = 0; },
    enqueueSteering(message) {
      steeringQueue.push(message);
      notify();
      for (const listener of steeringListeners) listener();
      return steeringQueue.length;
    },
    hasSteering: () => steeringQueue.length > 0,
    onSteering(listener) { steeringListeners.add(listener); return () => steeringListeners.delete(listener); },
    consumeSteering() { const messages = steeringQueue.splice(0); if (messages.length) notify(); return messages; },
    async waitIfPaused(signal) {
      while (true) {
        if (stopped || signal?.aborted) throw interrupted();
        await durableTail;
        if (stopped || signal?.aborted) throw interrupted();
        if (!reasons.size) return;
        await new Promise((resolve, reject) => {
          const clean = () => { listeners.delete(changed); signal?.removeEventListener("abort", aborted); };
          const changed = () => { clean(); resolve(); };
          const aborted = () => { clean(); reject(interrupted()); };
          listeners.add(changed);
          signal?.addEventListener("abort", aborted, { once: true });
          if (signal?.aborted) aborted();
        });
      }
    },
    async runRequest(execute, signal) {
      await api.waitIfPaused(signal);
      const request = new AbortController();
      let suspended = false;
      const abort = () => request.abort(signal?.reason);
      const unsubscribe = api.onChange(() => {
        if (api.environmentPaused) { suspended = true; request.abort(); }
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        const result = await execute(request.signal);
        if (stopped || signal?.aborted) throw interrupted();
        if (suspended) throw Object.assign(new Error("Inference suspended; no tool calls executed."), { code: "TASK_SUSPENDED", usage: result?.attemptUsage || result?.usage });
        return result;
      } catch (error) {
        if (suspended && !stopped && !signal?.aborted) error.code = "TASK_SUSPENDED";
        throw error;
      } finally { unsubscribe(); signal?.removeEventListener("abort", abort); }
    },
    abort() { stopped = true; clearRetry(); reasons.clear(); notify(); },
  };
  return api;
}

// Narrow transport classification: never turn auth, quota, HTTP failures,
// invalid certificates or arbitrary programming TypeErrors into an endless wait.
export function isTemporaryNetworkError(error) {
  if (Number(error?.status) > 0) return false;
  const codes = [error?.code, error?.cause?.code];
  if (codes.some((code) => /CERT|TLS|SSL|INVALID_URL/i.test(String(code)))) return false;
  return codes.some((code) => /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETDOWN|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|PROVIDER_STREAM_INCOMPLETE)$/.test(String(code))) ||
    error instanceof TypeError && /^(fetch failed|failed to fetch|network request failed|terminated)$/i.test(error.message);
}

// Command watchdogs measure active time, not time spent sleeping/waiting.
export function activeTimeout(callback, ms, control) {
  if (!control) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); }
  const deadline = control.activeNow() + ms;
  let timer, cancelled = false;
  const check = () => {
    if (cancelled) return;
    const remaining = deadline - control.activeNow();
    if (!control.paused && remaining <= 0) { cancel(); callback(); }
    else timer = setTimeout(check, control.paused ? 1000 : Math.min(1000, Math.max(10, remaining)));
  };
  const unsubscribe = control.onChange(() => { clearTimeout(timer); if (!cancelled) check(); });
  const cancel = () => { cancelled = true; clearTimeout(timer); unsubscribe(); };
  check();
  return cancel;
}

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteFile } from '../storage/atomic-file.js';
import { createResponseCapture } from './model-response-capture-core.js';

// Trusted main-process setup only. Not exposed to model tools, IPC or Cloud.
// Defaults OFF; an explicit startup flag arms one actual request attempt.
let configuration = null;
const pendingWrites = new Set();
// Test/diagnostic shutdown helper only; inference never waits on this barrier.
export async function drainModelResponseDiagnostics() {
  while (pendingWrites.size) await Promise.all([...pendingWrites]);
}
async function writeSnapshot(path, record) {
  for (let attempt = 0; ; attempt++) {
    try { await atomicWriteFile(path, JSON.stringify(record), { mode: 0o600 }); return; }
    catch (error) {
      // Windows readers may briefly hold the previous snapshot open. Only retry
      // this local file replacement, never the model request.
      if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await new Promise(done => setTimeout(done, 10 * (attempt + 1)));
    }
  }
}
export function configureModelResponseDiagnostics({ dataDirectory, requests = 1 } = {}) {
  if (dataDirectory === undefined) { configuration = null; return; }
  if (typeof dataDirectory !== 'function' || !Number.isSafeInteger(requests) || requests < 1 || requests > 3) throw new Error('Invalid local diagnostic configuration.');
  configuration = { dataDirectory, remaining: requests };
}

function tokenCounts(value) {
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).filter(([key, n]) =>
    /^(?:input|output|prompt|completion|total|reasoning|cached|cache_read_input|cache_creation_input|prompt_cache_hit|prompt_cache_miss)_tokens$/.test(key) && Number.isSafeInteger(n) && n >= 0));
}

export function beginModelResponseDiagnostic({ protocol, modelId, trace = {} } = {}) {
  if (!configuration?.remaining) return null;
  // Consume synchronously so concurrent workers cannot all claim one capture.
  const config = configuration; config.remaining--;
  try {
    const attemptId = randomUUID();
    const path = join(config.dataDirectory(), 'diagnostics', 'model-responses', `${attemptId}.json`);
    const capture = createResponseCapture({ protocol: protocol === 'chat-completions' ? 'openai-chat' : protocol,
      requestId: trace.logicalRequestId || attemptId, attemptId, phaseId: 'model-response' });
    const identity = { modelId, taskId: trace.taskId || null, runId: trace.runId || null, agentId: trace.agentId || 'main' };
    let gate = Promise.resolve(), timer = null, closed = false, observerFailed = false;
    const persist = (snapshot, requestOutcome = 'receiving') => {
      // Never serialize provider config, headers, raw payloads, tool arguments,
      // request messages or error text into this local response-only record.
      const record = { version: 1, localOnly: true, ...identity, ...snapshot,
        usage: tokenCounts(snapshot.usage), observerFailed, requestOutcome, savedAt: new Date().toISOString() };
      gate = gate.catch(() => {}).then(() => writeSnapshot(path, record)).catch(() => {});
      const pending = gate;
      pendingWrites.add(pending);
      void pending.then(() => pendingWrites.delete(pending));
    };
    const flush = () => {
      timer = null;
      try { persist(capture.snapshot()); } catch { observerFailed = true; }
    };
    const schedule = () => { if (!timer) { timer = setTimeout(flush, 1000); timer.unref?.(); } };
    persist(capture.snapshot());
    return {
      path,
      observe(payload) {
        if (closed || observerFailed) return;
        try { capture.accept(payload); schedule(); } catch { observerFailed = true; }
      },
      async finish({ outcome = 'completed', interrupted = false } = {}) {
        if (closed) return gate;
        closed = true; clearTimeout(timer);
        try { persist(capture.end({ interrupted }), outcome); } catch { observerFailed = true; }
        // Storage failure is diagnostic-only and must never retry a paid request.
        await gate;
      },
    };
  } catch { return null; }
}

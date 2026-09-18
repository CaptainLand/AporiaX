import { requestFingerprint } from "./request-compiler.js";
import { mergeTokenUsage } from "./token-usage.js";

// Per-run counters only. Never retain prompt text, tool arguments, raw output,
// credentials, or a growing event history in diagnostic metrics.
export class LoopMetrics {
  #data = { version: 1, requests: 0, attempts: 0, failedAttempts: 0, retries: 0,
    requestedRetryWaitMs: 0, modelMs: 0, toolCalls: 0, toolMs: 0,
    compactions: 0, estimatedTokensRemoved: 0, recoveries: 0,
    noProgressWarnings: 0, completionContinuations: 0,
    prefixComparisons: 0, unchangedLeadingMessages: 0,
    toolSchemaChanges: 0, usage: null, attemptsWithoutUsage: 0 };
  #previous = null;
  #tools = new Map();
  request(body) {
    const fingerprint = requestFingerprint(body);
    const previous = this.#previous;
    this.#data.requests++;
    if (previous) {
      this.#data.prefixComparisons++;
      if (previous.toolSchemaHash !== fingerprint.toolSchemaHash) this.#data.toolSchemaChanges++;
      if (previous.model === fingerprint.model && previous.toolSchemaHash === fingerprint.toolSchemaHash) {
        let count = 0;
        while (count < previous.messageHashes.length && count < fingerprint.messageHashes.length &&
          previous.messageHashes[count] === fingerprint.messageHashes[count]) count++;
        this.#data.unchangedLeadingMessages += count;
      }
    }
    // This is a prefix-comparison diagnostic, NOT a billed cache-hit estimate.
    this.#previous = { ...fingerprint, messageHashes: fingerprint.messageHashes.slice(0, 1024) };
  }
  observe(event) {
    const data = this.#data;
    if (event.type === "response.attempt.started") data.attempts++;
    if (event.type === "response.attempt.completed") {
      data.modelMs += Math.max(0, Number(event.durationMs) || 0);
      if (event.status !== "completed") data.failedAttempts++;
      if (event.usage) data.usage = mergeTokenUsage(data.usage, event.usage);
      else data.attemptsWithoutUsage++;
    }
    if (event.type === "response.retry") { data.retries++; data.requestedRetryWaitMs += Number(event.delayMs) || 0; }
    if (event.type === "response.recovery") data.recoveries++;
    if (event.type === "context.compacted") {
      data.compactions++;
      data.estimatedTokensRemoved += Math.max(0, (event.estimatedTokensBefore || 0) - (event.estimatedTokensAfter || 0));
    }
    if (event.type === "runtime.no_progress.warning") data.noProgressWarnings++;
    if (event.type === "completion.continue") data.completionContinuations++;
    if (event.type === "tool.started") {
      data.toolCalls++;
      if (event.callId && this.#tools.size < 512) this.#tools.set(event.callId, performance.now());
    }
    if (event.type === "tool.completed" && this.#tools.has(event.callId)) {
      data.toolMs += performance.now() - this.#tools.get(event.callId);
      this.#tools.delete(event.callId);
    }
  }
  snapshot() {
    return { ...this.#data, modelMs: Math.round(this.#data.modelMs), toolMs: Math.round(this.#data.toolMs),
      activeToolTimers: this.#tools.size, cacheDiagnostic: "message-prefix-only-not-provider-cache",
      usage: this.#data.usage ? { ...this.#data.usage } : null };
  }
}

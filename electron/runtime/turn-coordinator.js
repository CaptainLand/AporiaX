const PHASES = new Set([
  "preparing",
  "model",
  "tools",
  "review",
  "finalizing",
  "completed",
  "failed",
  "interrupted",
]);

function abortError() {
  const error = new Error("The run was interrupted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function safeCount(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

export class TurnCoordinator {
  #runId;
  #emit;
  #control;
  #phase = "preparing";
  #round = 0;
  #toolBatches = 0;
  #toolCalls = 0;
  #continuations = 0;
  #terminal = false;

  constructor({ runId = "", emit = () => {}, control = null } = {}) {
    this.#runId = String(runId || "");
    this.#emit = typeof emit === "function" ? emit : () => {};
    this.#control = control;
  }

  get phase() {
    return this.#phase;
  }

  get round() {
    return this.#round;
  }

  async beginRound({ signal, applyControlBoundary = null } = {}) {
    if (this.#terminal) throw new Error("Cannot begin another round after the run is terminal.");
    throwIfAborted(signal);
    await this.#control?.waitIfPaused?.(signal);
    if (typeof applyControlBoundary === "function") {
      await applyControlBoundary();
    }
    throwIfAborted(signal);
    this.#round += 1;
    this.transition("model", { reason: "round-start" });
    return { round: this.#round, phase: this.#phase };
  }

  observeModelResponse(message) {
    if (this.#terminal) return { kind: "terminal", toolCalls: [] };
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length) {
      this.transition("tools", { toolCalls: toolCalls.length });
      return { kind: "tools", toolCalls };
    }
    this.transition("finalizing", { reason: "model-no-tools" });
    return { kind: "final", toolCalls: [] };
  }

  beginToolBatch(toolCalls, { parallel = false } = {}) {
    if (this.#terminal) throw new Error("Cannot execute tools after the run is terminal.");
    const count = Array.isArray(toolCalls) ? toolCalls.length : safeCount(toolCalls);
    this.#toolBatches += 1;
    this.#toolCalls += count;
    this.transition("tools", {
      reason: parallel ? "parallel-tool-batch" : "tool-batch",
      toolCalls: count,
      parallel: Boolean(parallel),
    });
    return { batch: this.#toolBatches, toolCalls: count };
  }

  beginReview(detail = {}) {
    this.transition("review", detail);
  }

  requestContinuation(reason = "continue") {
    if (this.#terminal) return;
    this.#continuations += 1;
    this.#emit({
      type: "turn.continuation.requested",
      runId: this.#runId || undefined,
      round: this.#round,
      reason: String(reason || "continue").slice(0, 160),
      count: this.#continuations,
    });
    this.#phase = "preparing";
  }

  transition(nextPhase, detail = {}) {
    const next = String(nextPhase || "").trim();
    if (!PHASES.has(next)) throw new Error(`Unsupported turn coordinator phase: ${next}`);
    if (this.#terminal && !["completed", "failed", "interrupted"].includes(next)) {
      throw new Error("Cannot leave a terminal turn phase.");
    }
    if (this.#phase === next && !detail?.force) return this.snapshot();
    const previous = this.#phase;
    this.#phase = next;
    if (["completed", "failed", "interrupted"].includes(next)) this.#terminal = true;
    this.#emit({
      type: "turn.phase.changed",
      runId: this.#runId || undefined,
      previous,
      phase: next,
      round: this.#round,
      toolBatches: this.#toolBatches,
      toolCalls: this.#toolCalls,
      ...detail,
    });
    return this.snapshot();
  }

  complete(detail = {}) {
    return this.transition("completed", { reason: "run-completed", ...detail });
  }

  fail(error) {
    const message = String(error?.message || error || "Run failed").slice(0, 800);
    return this.transition("failed", { reason: "run-failed", error: message });
  }

  interrupt(detail = {}) {
    return this.transition("interrupted", { reason: "run-interrupted", ...detail });
  }

  snapshot() {
    return Object.freeze({
      runId: this.#runId || null,
      phase: this.#phase,
      round: this.#round,
      toolBatches: this.#toolBatches,
      toolCalls: this.#toolCalls,
      continuations: this.#continuations,
      terminal: this.#terminal,
    });
  }
}

export function createTurnCoordinator(options) {
  return new TurnCoordinator(options);
}

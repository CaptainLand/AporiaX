import { randomUUID } from "node:crypto";
import { AsyncResource } from "node:async_hooks";

export class HarnessScheduler {
  #queue = [];
  #running = new Map();
  #concurrency;
  #eventBus;

  constructor({ concurrency = 4, eventBus = null } = {}) {
    this.#concurrency = Math.max(1, Math.min(32, Number(concurrency) || 4));
    this.#eventBus = eventBus;
  }

  enqueue({ id = randomUUID(), kind = "task", priority = 0, metadata = {}, signal, run }) {
    if (typeof run !== "function") throw new TypeError("Scheduled job requires a run function.");
    if (this.#running.has(String(id)) || this.#queue.some((job) => job.id === String(id)))
      throw new Error(`Duplicate scheduled job id: ${id}`);
    const job = {
      id: String(id),
      kind: String(kind || "task"),
      priority: Number(priority) || 0,
      metadata: { ...metadata },
      run: AsyncResource.bind(run),
      queuedAt: Date.now(),
      resolve: null,
      reject: null,
      signal,
      abortQueued: null,
    };
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    this.#queue.push(job);
    job.abortQueued = () => {
      const index = this.#queue.indexOf(job);
      if (index < 0) return;
      this.#queue.splice(index, 1);
      signal?.removeEventListener("abort", job.abortQueued);
      job.reject(Object.assign(new Error("Scheduled job cancelled before execution."), { name: "AbortError" }));
      this.#drain();
    };
    signal?.addEventListener("abort", job.abortQueued, { once: true });
    if (signal?.aborted) job.abortQueued();
    this.#queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
    this.#eventBus?.emit({
      type: "scheduler.queued",
      jobId: job.id,
      kind: job.kind,
      metadata: job.metadata,
      runId: job.metadata.runId,
      parentTaskId: job.metadata.parentTaskId,
    });
    this.#drain();
    return { id: job.id, promise };
  }

  #drain() {
    while (this.#running.size < this.#concurrency && this.#queue.length) {
      const job = this.#queue.shift();
      job.signal?.removeEventListener("abort", job.abortQueued);
      this.#running.set(job.id, job);
      this.#eventBus?.emit({
        type: "scheduler.started",
        jobId: job.id,
        kind: job.kind,
        metadata: job.metadata,
        runId: job.metadata.runId,
        parentTaskId: job.metadata.parentTaskId,
      });
      Promise.resolve()
        .then(() => job.run())
        .then((result) => {
          this.#running.delete(job.id);
          job.resolve(result);
          this.#eventBus?.emit({
            type: "scheduler.completed",
            jobId: job.id,
            kind: job.kind,
            runId: job.metadata.runId,
            parentTaskId: job.metadata.parentTaskId,
          });
          this.#drain();
        })
        .catch((error) => {
          this.#running.delete(job.id);
          job.reject(error);
          this.#eventBus?.emit({
            type: "scheduler.failed",
            jobId: job.id,
            kind: job.kind,
            error: String(error?.message || error),
            runId: job.metadata.runId,
            parentTaskId: job.metadata.parentTaskId,
          });
          this.#drain();
        });
    }
  }

  snapshot() {
    return {
      concurrency: this.#concurrency,
      queued: this.#queue.map((job) => ({ id: job.id, kind: job.kind, priority: job.priority, metadata: job.metadata })),
      running: [...this.#running.values()].map((job) => ({ id: job.id, kind: job.kind, priority: job.priority, metadata: job.metadata })),
    };
  }
}

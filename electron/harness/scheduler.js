import { randomUUID } from "node:crypto";

export class HarnessScheduler {
  #queue = [];
  #running = new Map();
  #concurrency;
  #eventBus;

  constructor({ concurrency = 4, eventBus = null } = {}) {
    this.#concurrency = Math.max(1, Math.min(32, Number(concurrency) || 4));
    this.#eventBus = eventBus;
  }

  enqueue({ id = randomUUID(), kind = "task", priority = 0, metadata = {}, run }) {
    if (typeof run !== "function") throw new TypeError("Scheduled job requires a run function.");
    const job = {
      id: String(id),
      kind: String(kind || "task"),
      priority: Number(priority) || 0,
      metadata: { ...metadata },
      run,
      queuedAt: Date.now(),
      resolve: null,
      reject: null,
    };
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    this.#queue.push(job);
    this.#queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
    this.#eventBus?.emit({ type: "scheduler.queued", jobId: job.id, kind: job.kind, metadata: job.metadata });
    this.#drain();
    return { id: job.id, promise };
  }

  #drain() {
    while (this.#running.size < this.#concurrency && this.#queue.length) {
      const job = this.#queue.shift();
      this.#running.set(job.id, job);
      this.#eventBus?.emit({ type: "scheduler.started", jobId: job.id, kind: job.kind, metadata: job.metadata });
      Promise.resolve()
        .then(() => job.run())
        .then((result) => {
          this.#running.delete(job.id);
          job.resolve(result);
          this.#eventBus?.emit({ type: "scheduler.completed", jobId: job.id, kind: job.kind });
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

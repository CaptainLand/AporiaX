import { createHash } from "node:crypto";

function versionOf(value) {
  if (value === null || value === undefined) return "missing";
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
}

export class ReviewCoordinator {
  #versions = new Map();
  #eventBus;

  constructor({ eventBus = null } = {}) {
    this.#eventBus = eventBus;
  }

  update(path, content) {
    const version = versionOf(content);
    this.#versions.set(String(path), version);
    this.#eventBus?.emit({ type: "review.version.updated", path: String(path), version });
    return version;
  }

  createBatch(paths) {
    const versions = new Map();
    for (const path of paths || []) {
      const key = String(path);
      versions.set(key, this.#versions.get(key) || "unknown");
    }
    return Object.freeze({
      createdAt: new Date().toISOString(),
      paths: Object.freeze([...versions.keys()]),
      versions,
    });
  }

  isCurrent(batch) {
    if (!batch?.versions) return false;
    return [...batch.versions.entries()].every(
      ([path, version]) => (this.#versions.get(path) || "unknown") === version,
    );
  }

  accept(batch, result) {
    const current = this.isCurrent(batch);
    this.#eventBus?.emit({
      type: current ? "review.result.accepted" : "review.result.stale",
      paths: batch?.paths || [],
    });
    return current ? result : null;
  }
}

export { versionOf as createContentVersion };

let defaultHarnessEventBus = null;

function normalizePattern(pattern) {
  const value = String(pattern || "*").trim();
  return value || "*";
}

function matchesPattern(pattern, type) {
  const normalized = normalizePattern(pattern);
  if (normalized === "*" || normalized === "**") return true;
  if (normalized === type) return true;
  if (normalized.endsWith(".*")) {
    const prefix = normalized.slice(0, -1);
    return type.startsWith(prefix);
  }
  return false;
}

function normalizePriority(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export class HarnessEventBus {
  #listeners = new Map();
  #hooks = [];
  #history = [];
  #sequence = 0;
  #maxHistory;
  #now;
  #onEvent;

  constructor({ onEvent = null, now = () => new Date(), maxHistory = 1_000 } = {}) {
    this.#onEvent = typeof onEvent === "function" ? onEvent : null;
    this.#now = typeof now === "function" ? now : () => new Date();
    this.#maxHistory = Math.max(0, Math.min(20_000, Number(maxHistory) || 0));
  }

  on(pattern, listener) {
    if (typeof listener !== "function") {
      throw new TypeError("Event listener must be a function.");
    }
    const key = normalizePattern(pattern);
    const listeners = this.#listeners.get(key) || new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(key);
    };
  }

  once(pattern, listener) {
    let unsubscribe = null;
    unsubscribe = this.on(pattern, (event) => {
      unsubscribe?.();
      listener(event);
    });
    return unsubscribe;
  }

  hook(pattern, handler, { id = "", priority = 0 } = {}) {
    if (typeof handler !== "function") {
      throw new TypeError("Hook handler must be a function.");
    }
    const hook = {
      id: String(id || `hook-${this.#hooks.length + 1}`),
      pattern: normalizePattern(pattern),
      priority: normalizePriority(priority),
      handler,
    };
    this.#hooks.push(hook);
    this.#hooks.sort((left, right) => right.priority - left.priority);
    return () => {
      const index = this.#hooks.indexOf(hook);
      if (index >= 0) this.#hooks.splice(index, 1);
    };
  }

  #enrich(event) {
    if (!event || typeof event.type !== "string" || !event.type.trim()) return null;
    this.#sequence += 1;
    const value = this.#now();
    const timestamp = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    return Object.freeze({
      sequence: this.#sequence,
      timestamp,
      ...event,
      type: event.type.trim(),
    });
  }

  #remember(event) {
    if (!this.#maxHistory) return;
    this.#history.push(event);
    if (this.#history.length > this.#maxHistory) {
      this.#history.splice(0, this.#history.length - this.#maxHistory);
    }
  }

  #matchingListeners(type) {
    const listeners = [];
    for (const [pattern, handlers] of this.#listeners) {
      if (!matchesPattern(pattern, type)) continue;
      listeners.push(...handlers);
    }
    return listeners;
  }

  #matchingHooks(type) {
    return this.#hooks.filter((hook) => matchesPattern(hook.pattern, type));
  }

  emit(event) {
    const enriched = this.#enrich(event);
    if (!enriched) return null;
    this.#remember(enriched);

    for (const hook of this.#matchingHooks(enriched.type)) {
      try {
        const result = hook.handler(enriched);
        if (result && typeof result.then === "function") {
          result.catch(() => undefined);
        }
      } catch {
        // Hooks are extension points. A broken observer must not crash the harness.
      }
    }

    for (const listener of this.#matchingListeners(enriched.type)) {
      try {
        listener(enriched);
      } catch {
        // Event observers are isolated from the runtime execution path.
      }
    }

    this.#onEvent?.(enriched);
    return enriched;
  }

  async emitAsync(event) {
    const enriched = this.#enrich(event);
    if (!enriched) return null;
    this.#remember(enriched);

    for (const hook of this.#matchingHooks(enriched.type)) {
      await hook.handler(enriched);
    }
    for (const listener of this.#matchingListeners(enriched.type)) {
      await listener(enriched);
    }
    await this.#onEvent?.(enriched);
    return enriched;
  }

  history({ since = 0, type = "*", limit = 200 } = {}) {
    const max = Math.max(1, Math.min(2_000, Number(limit) || 200));
    return this.#history
      .filter((event) => event.sequence > Number(since || 0))
      .filter((event) => matchesPattern(type, event.type))
      .slice(-max);
  }

  snapshot() {
    return {
      sequence: this.#sequence,
      listeners: [...this.#listeners.entries()].map(([pattern, handlers]) => ({
        pattern,
        count: handlers.size,
      })),
      hooks: this.#hooks.map((hook) => ({
        id: hook.id,
        pattern: hook.pattern,
        priority: hook.priority,
      })),
      historySize: this.#history.length,
    };
  }
}

export function createHarnessEventBus(options) {
  return new HarnessEventBus(options);
}

export { matchesPattern as eventPatternMatches };

export function setDefaultHarnessEventBus(bus) {
  defaultHarnessEventBus = bus && typeof bus.emit === "function" ? bus : null;
  return defaultHarnessEventBus;
}

export function getDefaultHarnessEventBus() {
  return defaultHarnessEventBus;
}

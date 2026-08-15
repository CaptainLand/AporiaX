const cloudModelActivityListeners = new Set();

export function emitCloudModelActivity(event = {}) {
  const payload = Object.freeze({
    type: String(event.type || "completed"),
    code: String(event.code || ""),
    timestamp: new Date().toISOString(),
  });
  for (const listener of cloudModelActivityListeners) {
    try {
      listener(payload);
    } catch {
      // Account observers must never interfere with the provider loop.
    }
  }
  return payload;
}

export function onCloudModelActivity(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("Cloud model activity listener must be a function.");
  }
  cloudModelActivityListeners.add(listener);
  return () => cloudModelActivityListeners.delete(listener);
}

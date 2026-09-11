// Optional desktop integration. CLI/tests retain their existing isolated runtimes.
let provider = null;
export function installWorkbenchProvider(value) { provider = value; }
export function acquireWorkbenchResources(context) { return provider?.acquire(context) || null; }

// Uses OS connectivity only; never probes an unrelated site or bills an LLM.
export function monitorTaskEnvironment({ powerMonitor, net, runtime, intervalMs = 5000 }) {
  let lastOnline;
  const online = () => { try { return net.isOnline(); } catch { return true; } };
  const sample = () => {
    const value = online();
    if (value !== lastOnline) { lastOnline = value; runtime.setEnvironment({ online: value }); }
  };
  const suspend = () => runtime.setEnvironment({ sleeping: true });
  const resume = () => { lastOnline = online(); runtime.setEnvironment({ sleeping: false, online: lastOnline }); };
  powerMonitor.on("suspend", suspend);
  powerMonitor.on("resume", resume);
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    powerMonitor.removeListener("suspend", suspend);
    powerMonitor.removeListener("resume", resume);
  };
}

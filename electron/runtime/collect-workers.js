// Wait on completion, not on insertion order. Always return to the model within
// a bounded interval; abort handlers/timers are removed on every exit path.
export async function waitForWorkers(records, { mode = "any", timeoutMs = 30000, signal } = {}) {
  const running = records.filter((record) => record.status === "running");
  if (!running.length || (mode === "any" && records.some((record) => record.status !== "running"))) return;
  if (signal?.aborted) throw Object.assign(new Error("Interrupted"), { name: "AbortError" });
  let timer;
  let abort;
  try {
    await Promise.race([
      mode === "all" ? Promise.all(running.map((record) => record.promise)) : Promise.race(running.map((record) => record.promise)),
      new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, Math.min(30000, Number(timeoutMs) || 0))); }),
      new Promise((_, reject) => {
        abort = () => reject(Object.assign(new Error("Interrupted"), { name: "AbortError" }));
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}
// Keep the default handoff small; full evidence remains available by id.
export function workerResultForModel(result, detail = "summary") {
  if (!result || result.status === 'running' || detail === "full") return result;
  if (result.executed === false && result.reason === 'CLOUD_QUOTA_WIND_DOWN') {
    return { agentId: result.agentId, role: result.role, status: result.status,
      executed: false, reason: result.reason, summary: String(result.summary || '').slice(0, 4000) };
  }
  const summary = String(result.summary || "").slice(0, 4000);
  const evidence = (result.evidence || []).slice(-8).map((item) => ({ ...item, preview: String(item.preview || "").slice(0, 300) }));
  return {
    agentId: result.agentId, role: result.role, status: result.status, summary, evidence,
    reportId: result.reportId, acceptance: result.acceptance,
    integrated: result.integrated, conflicts: result.conflicts, changes: result.changes,
    rounds: result.rounds, usage: result.usage,
    detailAvailable: true,
    detailHint: "Use collect_subagents with this agent_id and detail=full for the retained report and tool evidence.",
  };
}

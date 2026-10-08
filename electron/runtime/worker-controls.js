// In-memory handles only. Durable state remains in the existing run store.
const runs = new Map();
export function registerWorkerControls({ runId, taskId, list, steer, stop }) {
  if (!runId) return () => {};
  if (runs.has(runId)) throw new Error('Worker controls already registered.');
  const entry = { taskId, list, steer, stop };
  runs.set(runId, entry);
  return () => { if (runs.get(runId) === entry) runs.delete(runId); };
}
export async function controlWorker(action, request) {
  if (!request || typeof request.runId !== 'string' || typeof request.taskId !== 'string') throw new Error('任务标识无效。');
  const run = runs.get(request.runId);
  if (!run || run.taskId !== request.taskId) throw new Error('本轮已结束或任务不匹配，请在下一轮继续。');
  if (action === 'list') return run.list();
  if (!['steer', 'stop'].includes(action) || typeof request.agentId !== 'string') throw new Error('Agent 操作无效。');
  return run[action](request);
}

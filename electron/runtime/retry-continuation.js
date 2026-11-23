import { resolve } from 'node:path';

const root = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
const invalid = message => Object.assign(new Error(message), { code: 'RETRY_CONTINUATION_UNAVAILABLE' });

// Resolve only inside the original task/request/workspace. Never silently turn
// an unavailable checkpoint into a fresh execution of the original instruction.
export async function loadTaskContinuation(request, load) {
  if (!request?.recoveryRunId) {
    if (request?.retryMode === 'continue') throw invalid('缺少继续任务的检查点，未从头重做。');
    return null;
  }
  const visited = new Set();
  let id = request.recoveryRunId;
  for (let depth = 0; depth < 100; depth++) {
    if (visited.has(id) || id === request.runId) throw invalid('恢复记录存在循环，未重复执行任务。');
    visited.add(id);
    const context = await load(id);
    if (!context || context.runId !== id) throw invalid('找不到对应的运行检查点，现有文件仍保留。');
    if (context.taskId && context.taskId !== request.taskId) throw invalid('检查点属于另一个任务，未接续。');
    if (context.sourceUserId && request.sourceUserId && context.sourceUserId !== request.sourceUserId)
      throw invalid('检查点属于另一条用户请求，未接续。');
    if (Boolean(context.workspacePath) !== Boolean(request.workspacePath) ||
      context.workspacePath && root(context.workspacePath) !== root(request.workspacePath))
      throw invalid('检查点属于另一个工作区，未接续。');
    // Repeated retry of a historical card follows its newest continuation,
    // rather than forking from obsolete file versions or replaying old work.
    if (context.resumedByRunId) { id = context.resumedByRunId; continue; }
    if (context.status === 'completed' && request.retryMode === 'continue')
      throw invalid('这一轮已经完成，请基于现有成果提出新的要求。');
    return context;
  }
  throw invalid('接续记录过长，未从头重做。');
}

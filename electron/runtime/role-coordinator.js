export function createRoleCoordinator(records, signal, limits = { maxActive: 12, builderLimit: 6 }) {
  const listeners = new Set(), active = new Map();
  let totalActive = 0, builders = 0;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  async function wait(check, childSignal) {
    while (true) {
      if (signal?.aborted || childSignal?.aborted) throw Object.assign(new Error('子 Agent 已停止。'), { name: 'AbortError' });
      if (check()) return;
      await new Promise((resolve, reject) => {
        const cleanup = () => { listeners.delete(wake); signal?.removeEventListener('abort', abort); childSignal?.removeEventListener('abort', abort); };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(Object.assign(new Error('子 Agent 已停止。'), { name: 'AbortError' })); };
        listeners.add(wake); signal?.addEventListener('abort', abort, { once: true }); childSignal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted || childSignal?.aborted) abort();
      });
    }
  }
  return {
    notify,
    validate(ids, ownId) {
      if (!Array.isArray(ids) || ids.length > 12 || new Set(ids).size !== ids.length) throw new Error('依赖列表无效。');
      for (const id of ids) {
        if (id === ownId || !records.has(id)) throw new Error('依赖必须是本轮已创建的其他 Agent。');
        const seen = new Set();
        const visit = current => {
          if (current === ownId || seen.has(current)) throw new Error('Agent 依赖成环。');
          seen.add(current);
          for (const parent of records.get(current)?.input?.dependsOn || []) visit(parent);
          seen.delete(current);
        };
        visit(id);
      }
    },
    async enter(record, profile) {
      if (profile.template === 'builder' && !limits.builderLimit) throw new Error('Builder 已在设置中关闭。');
      await wait(() => {
        return (record.input.dependsOn || []).every(id => {
          const dep = records.get(id);
          if (!dep || ['failed', 'interrupted', 'cancelled', 'blocked', 'budget_exhausted', 'partial', 'needs_input'].includes(dep.status) || dep.result?.acceptance?.status === 'needs_changes') throw new Error(`DEPENDENCY_BLOCKED: ${id}`);
          return dep.status === 'completed' && dep.result?.acceptance?.status === 'accepted' && (dep.role !== 'builder' || dep.result?.integrated === true);
        });
      }, record.controller.signal);
      record.session.dependencyReports = Object.fromEntries((record.input.dependsOn || []).map(id => [id, records.get(id).result.reportId]));
      record.phase = 'queued'; notify();
      await wait(() => totalActive < limits.maxActive && (active.get(profile.id) || 0) < profile.concurrency &&
        (profile.template !== 'builder' || builders < limits.builderLimit), record.controller.signal);
      active.set(profile.id, (active.get(profile.id) || 0) + 1);
      totalActive++; if (profile.template === 'builder') builders++;
      let released = false;
      return () => { if (!released) { released = true; totalActive--; if (profile.template === 'builder') builders--; active.set(profile.id, active.get(profile.id) - 1); notify(); } };
    },
    assertDependencies(record) {
      for (const [id, reportId] of Object.entries(record.session.dependencyReports || {})) {
        const dep = records.get(id);
        if (dep?.status !== 'completed' || dep.result?.reportId !== reportId || dep.result?.acceptance?.status !== 'accepted')
          throw new Error(`DEPENDENCY_CHANGED: ${id} 的已验收结果发生变化，请主 Agent 重新安排。`);
      }
    },
  };
}

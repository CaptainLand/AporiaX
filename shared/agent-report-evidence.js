// These facts come from executed tool receipts, never from a model's verdict.
// They describe observed actions, not full test coverage or acceptance.
export function observedWorkerChecks(result = {}) {
  result ||= {};
  const items = [...(result.steps || []).map(item => ({ ...item, tool: item.name })), ...(result.evidence || [])];
  const readPaths = new Set(), commands = new Map(); let browserObserved = false;
  for (const item of items) {
    if (!item || item.success === false || item.error || item.timedOut || item.skipped) continue;
    if (item.tool === 'read_file' && typeof item.path === 'string') readPaths.add(item.path.slice(0, 500));
    if (['run_command', 'verify_project'].includes(item.tool) && Number.isInteger(item.exitCode)) {
      const command = String(item.command || '').slice(0, 1000);
      if (command) commands.set(command, { command, exitCode: item.exitCode, ...(item.parseOnly ? { parseOnly: true } : {}) });
    }
    if (/^browser_(?:snapshot|screenshot|click|fill|press)$/.test(item.tool || '')) browserObserved = true;
  }
  return { source: 'runtime-observed-tools', readPaths: [...readPaths].slice(-30), commands: [...commands.values()].slice(-12), browserObserved };
}

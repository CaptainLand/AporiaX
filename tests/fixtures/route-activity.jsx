import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { WorkbenchContext } from '../../src/workbench/use-workbench.js';
import { RouteView } from '../../src/conversation/ConversationViews.jsx';
import { createWitnessMonitor } from '../../electron/witness-monitor.js';
import '../../src/styles.css';
import '../../src/workbench/side-chat.css';

localStorage.setItem('aporiax.language.v1', 'zh-CN');
let clock = Date.now() - 35000;
const monitor = createWitnessMonitor({ heartbeatMs: 0, now: () => clock });
const emit = (event) => { clock += 1000; monitor.observe(event); };
emit({ type: 'turn.started', agentBudget: { builderConcurrency: 4 } });
emit({ type: 'tool.started', callId: 'missing', tool: 'read_file', path: 'missing.md' });
emit({ type: 'tool.completed', callId: 'missing', tool: 'read_file', path: 'missing.md', success: false, error: 'ENOENT: file not found', exitCode: 1 });
emit({ type: 'subagent.started', agentId: 'builder-1', activationId: 'builder-1:1', role: 'builder', task: '实现账户页面' });
emit({ type: 'subagent.tool.started', agentId: 'builder-1', role: 'builder', callId: 'write', tool: 'write_file', path: 'src/account.jsx' });
emit({ type: 'subagent.started', agentId: 'verify-1', role: 'verify', task: '验证已有登录流程' });
emit({ type: 'subagent.tool.started', agentId: 'verify-1', role: 'verify', callId: 'test', tool: 'run_command', command: 'npm run test:login' });
emit({ type: 'response.reset', round: 2 });

function Fixture() {
  const [task, setTask] = useState({ id: 'route-fixture', title: '实现账户页面', workspacePath: 'D:/Fixture', messages: [
    { id: 'old', role: 'assistant', status: 'completed', prompt: '上一轮：检查项目结构', route: [{ id: 'legacy', tool: 'read_file', title: '读取文件', status: 'completed', path: 'package.json' }] },
    { id: 'live', role: 'assistant', status: 'running', prompt: '实现账户页面，并验证登录流程', witness: monitor.snapshot(), plan: { steps: [{ id: 'p1', title: '实现账户页面', status: 'in_progress' }, { id: 'p2', title: '验证登录流程', status: 'pending' }] }, changes: [{ path: 'src/account.jsx', additions: 4, deletions: 1, beforeContent: 'old\n', afterContent: 'new\n' }] },
  ] });
  window.routeFixture = {
    calls: window.routeFixture?.calls || [],
    emit: (event) => { emit(event); setTask((value) => ({ ...value, messages: value.messages.map((message) => message.id === 'live' ? { ...message, witness: monitor.snapshot(), status: event.type === 'turn.completed' ? event.status || 'completed' : message.status } : message) })); },
    append: () => setTask((value) => ({ ...value, messages: [...value.messages, { id: 'next', role: 'assistant', status: 'running', prompt: '下一轮任务', witness: { status: 'running', records: [] } }] })),
    bulk: () => {
      for (let i = 0; i < 85; i++) {
        emit({ type: 'tool.started', tool: 'read_file', callId: `bulk-${i}`, path: `src/file-${i}.js` });
        emit({ type: 'tool.completed', tool: 'read_file', callId: `bulk-${i}`, success: true });
      }
      setTask((value) => ({ ...value, messages: value.messages.map((message) => message.id === 'live' ? { ...message, witness: monitor.snapshot() } : message) }));
    },
  };
  const workbench = { openHref: async (path) => { if (path === 'missing.md') throw new Error('文件不存在：missing.md'); window.routeFixture.calls.push({ type: 'file', path }); return true; } };
  return <WorkbenchContext.Provider value={workbench}><div style={{ height: '100vh', overflow: 'auto' }}><RouteView task={task} isRunning={task.messages.at(-1).status === 'running'} onNotice={() => {}} onSaveChanges={() => {}} onRevert={async () => { window.routeFixture.calls.push({ type: 'revert' }); }} /></div></WorkbenchContext.Provider>;
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>);

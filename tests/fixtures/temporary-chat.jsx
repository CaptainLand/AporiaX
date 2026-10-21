import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { WorkbenchLayout } from '../../src/workbench/WorkbenchLayout.jsx';
import { WorkbenchContext, useWorkbench } from '../../src/workbench/use-workbench.js';
import { Conversation } from '../../src/conversation/ConversationViews.jsx';
import '../../src/styles.css';

localStorage.setItem('aporiax.language.v1', 'zh-CN');
const listeners = new Set();
const stream = new EventSource('/__temporary/events'); stream.onmessage = event => { const value = JSON.parse(event.data); for (const fn of listeners) fn(value); };
window.desktop = {
  sideChat: { request: async input => {
    const response = await fetch('/__temporary/request', { method: 'POST', body: JSON.stringify(input) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
  }, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } },
  core: { skills: async () => ({ skills: [] }), capabilities: async () => ({ capabilities: [] }) },
  workbench: { request: async input => input.action === 'list' ? [] : true, subscribe: () => () => {} },
};
const providers = [{ id: 'fixture', name: 'Fixture', vendor: 'deepseek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsTools: true, supportsThinking: true, thinkingMode: 'deepseek' }] }];
const task = { id: 'ui-task', title: '主任务', workspacePath: '', providerId: 'fixture', modelId: 'deepseek-v4-flash', thinking: true, effort: 'high',
  messages: [{ id: 'original', role: 'user', content: '设计一个海岸动画。' }, { id: 'main', role: 'assistant', status: 'running', content: '正在处理海岸动画，主任务继续独立运行。' }] };
function Fixture() {
  const wb = useWorkbench(task), [ticks, setTicks] = useState(0); window.wb = wb;
  useEffect(() => { const timer = setInterval(() => setTicks(n => n + 1), 100); return () => clearInterval(timer); }, []);
  return <WorkbenchContext.Provider value={wb}><style>{'.task-workspace{display:flex;height:100vh;background:var(--gray-1)}.thread{flex:1;min-width:420px;overflow:auto}.fixture-top{padding:22px 28px;color:var(--gray-10);font-size:13px}.fixture-top button{margin-right:10px;padding:6px 10px;background:var(--gray-3);border-radius:6px}'}</style>
    <div className="task-workspace"><main className="thread"><div className="fixture-top"><button onClick={() => wb.open('sidechat')}>打开临时聊天</button><button onClick={() => document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'}>切换主题</button><output id="ticks">{ticks}</output></div><Conversation task={task} isRunning /></main>
      {wb.layout.open && <WorkbenchLayout workbench={wb} builtins={{ route: <p>主任务仍在运行</p> }} sideChat={{ providers }} />}
    </div></WorkbenchContext.Provider>;
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>);

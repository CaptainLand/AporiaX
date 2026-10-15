import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { ApprovalCard, FileExplorerPanel } from '../../src/agent-components.jsx';
import { Composer } from '../../src/composer/Composer.jsx';
import { WorkbenchContext } from '../../src/workbench/use-workbench.js';
import { WorkbenchContent } from '../../src/workbench/WorkbenchPanes.jsx';
import '../../src/styles.css';
import '../../src/workbench/workbench.css';
import '../../src/test-feedback-polish.css';

localStorage.setItem('aporiax.language.v1', 'zh-CN');
const entries = [{ path: '中 文.txt', name: '中 文.txt', type: 'file' }];
window.fixture = { action: 'add-to-chat', calls: [], sent: [], notices: [], decisions: [], opened: [] };
window.desktop = { workspace: {
  listTree: async () => ({ entries }),
  fileMenu: async request => {
    window.fixture.calls.push(request);
    if (window.fixture.pending) return new Promise(resolve => { window.fixture.resolveMenu = () => resolve({ action: 'add-to-chat', path: request.path }); });
    if (window.fixture.fail) throw new Error('Fixture menu failure');
    return window.fixture.action ? { action: window.fixture.action, path: request.path } : null;
  },
}, core: { skills: async () => ({ skills: [] }), mcp: async () => ({ servers: [] }) } };
const providers = [{ id: 'fixture', name: 'Fixture', models: [{ id: 'mock', name: 'Mock', supportsTools: true }] }];
function Fixture() {
  const [task, setTask] = useState({ id: 'one', workspacePath: 'D:/Demo', providerId: 'fixture', modelId: 'mock', messages: [] });
  const [quoteRequest, setQuoteRequest] = useState(null);
  window.fixture.switchTask = () => setTask(current => ({ ...current, id: 'two', workspacePath: 'D:/OtherDemo' }));
  const notice = value => window.fixture.notices.push(value);
  const workbench = { task, key: task.id, openFile: path => window.fixture.opened.push(path),
    request: async () => ({ entries }), addFileToChat: path => setQuoteRequest({ kind: 'file', path, taskId: task.id }) };
  return <WorkbenchContext.Provider value={workbench}><div className="task-workspace" style={{ height: '100vh', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px' }}>
    <section className="thread" style={{ padding: 20, overflow: 'auto' }}>
      <ApprovalCard approval={{ id: 'test-approval', kind: 'agent-role-change', title: '修改自定义角色：测试角色', command: 'update custom-role · revision 1', reason: '用户要求调整职责', canRememberForRun: false,
        description: JSON.stringify({ name: { before: '旧角色', after: '新角色' }, instructions: { before: '', after: '只核对证据，不执行代码。<script>unsafe()</script>' }, maxRequests: { before: 24, after: 10 } }) }}
        onRespond={(approved, scope) => window.fixture.decisions.push({ approved, scope })} />
      <Composer task={task} quoteRequest={quoteRequest} providers={providers} onNotice={notice} onSend={message => window.fixture.sent.push(message)} onUpdateTask={() => {}} />
    </section>
    <WorkbenchContent tab={{ kind: 'workspace' }} task={task} workbench={workbench} onNotice={notice}
      builtins={{ workspace: <FileExplorerPanel workspacePath={task.workspacePath} embedded onNotice={notice} onOpenFile={workbench.openFile} /> }} />
  </div></WorkbenchContext.Provider>;
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>);

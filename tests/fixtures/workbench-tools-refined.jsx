import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { WorkbenchContent } from '../../src/workbench/WorkbenchPanes.jsx';
import { peekTerminalSession } from '../../src/workbench/terminal-session.js';
import '../../src/styles.css';
import '../../src/workbench/workbench.css';

localStorage.clear(); localStorage.setItem('aporiax.language.v1', 'zh-CN');
const task = { id: 'refined-tools', workspacePath: 'D:/Demo/Starlight' };
const git = { repository: true, root: task.workspacePath, branch: 'main', remotes: ['origin'], ahead: 1, behind: 0, upstream: 'origin/main', revision: 'demo', head: 'demo', files: [
  { path: 'src/App.jsx', staged: true, unstaged: false, x: 'M', y: ' ' },
  { path: 'src/tokens.css', staged: false, unstaged: true, x: ' ', y: 'M' },
  { path: 'docs/design.md', staged: false, unstaged: true, x: '?', y: '?', untracked: true },
] };
const output = '\x1b[36mAporiaX · Starlight\x1b[0m\r\nPS D:\\Demo\\Starlight> npm test\r\n\r\n  \x1b[32m✓\x1b[0m 文件列表\r\n  \x1b[32m✓\x1b[0m 主题切换\r\n  \x1b[32m✓\x1b[0m 工作区预览\r\n\r\nTests: 12 passed, 12 total\r\nPS D:\\Demo\\Starlight> ';
window.toolsFixture = { calls: [], drafts: {}, opened: [], errors: [], bounds: [] };
function Fixture() {
  const [kind, setKind] = useState('git'), [covered, setCovered] = useState(false);
  const [resource, setResource] = useState({ id: 'browser-demo', url: 'about:blank', owner: 'user', status: 'running' });
  const request = async input => {
    window.toolsFixture.calls.push(input);
    if (input.action === 'git') {
      if (input.operation === 'diff') return { text: '@@ -1,2 +1,2 @@\n-const theme = "old";\n+const theme = "shared";' };
      if (input.operation === 'log') return [{ hash: 'abc123', shortHash: 'abc123', subject: '统一工作台的主题与文件入口', author: 'Demo', date: '2026-10-15T00:00:00Z' }];
      return structuredClone(git);
    }
    if (input.action === 'read') return { status: 'running', output: output.slice(input.cursor || 0), cursor: output.length };
    if (input.action === 'console') return { entries: [{ type: 'info', text: 'Starlight preview ready' }, { type: 'warn', text: '演示提示：未连接真实网页' }], network: [] };
    if (input.action === 'navigate') setResource(current => ({ ...current, url: input.url }));
    return true;
  };
  const workbench = { key: task.id, task, request, dirty: { current: new Set() }, draft: key => window.toolsFixture.drafts[key], saveDraft: (key, value) => { window.toolsFixture.drafts[key] = value; },
    openFile: path => window.toolsFixture.opened.push(path), setError: error => window.toolsFixture.errors.push(error), hideBrowser: async () => { window.toolsFixture.bounds.push({ hidden: true }); },
    layoutBrowser: async (_, bounds) => { window.toolsFixture.bounds.push(bounds); return true; }, close: async () => true, create: async () => true };
  Object.assign(window.toolsFixture, { kind: setKind, covered: setCovered, owner: owner => setResource(current => ({ ...current, owner })), nativeConsole: () => setResource(current => ({ ...current, consoleToggleSeq: (current.consoleToggleSeq || 0) + 1 })), terminal: () => peekTerminalSession(task.id, 'terminal-demo') });
  const terminalResource = { ...task, taskId: task.id, id: 'terminal-demo', kind: 'terminal', cwd: task.workspacePath, status: 'running', owner: 'user' };
  return <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-app)' }}>
    <WorkbenchContent tab={{ kind, id: kind === 'browser' ? 'browser-demo' : 'terminal-demo' }} task={task} resource={kind === 'terminal' ? terminalResource : resource} workbench={workbench} covered={covered} builtins={{}} onNotice={() => {}} />
  </div>;
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>);

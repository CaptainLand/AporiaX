import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { FileExplorerPanel } from '../../src/agent-components.jsx';
import { ProjectUnderstandingPanel } from '../../src/understanding/ProjectUnderstandingPanel.jsx';
import { WorkspaceFilePreview } from '../../src/workbench/WorkspaceFilePreview.jsx';
import { WorkbenchContent } from '../../src/workbench/WorkbenchPanes.jsx';
import { WorkbenchContext } from '../../src/workbench/use-workbench.js';
import '../../src/styles.css';
import '../../src/workbench/workbench.css';

localStorage.setItem('aporiax.language.v1', 'zh-CN');
const root = [
  { name: 'src', path: 'src', type: 'directory' },
  { name: 'docs', path: 'docs', type: 'directory' },
  ...['README.md', 'package.json', '设计说明.md'].map(name => ({ name, path: name, type: 'file' })),
];
const state = { currentRevision: 1, settings: { autoCurate: false }, revisions: [], facts: [
  ['architecture', '前端使用 React 与 Vite，桌面端由 Electron 提供本地工作区能力。', 'package.json'],
  ['module', '工作区浏览与编辑相互独立，预览不会覆盖编辑中的草稿。', 'src/workspace.jsx'],
  ['convention', '颜色使用主题变量，重要操作强调主色，分区使用柔和底色。', 'src/tokens.css'],
  ['preference', '界面中文优先，信息保持紧凑，默认折叠次要的执行细节。', '设计说明.md'],
  ['command', '运行 npm run build 验证产品构建。', 'package.json'],
  ['verification', '文件和知识变更必须保留来源与验证结果。', 'docs/checks.md'],
  ['known_issue', '当前安装包尚未签名，分发前需要告知用户。', 'docs/release.md'],
  ['decision', '项目知识按需读取，启用设置只作用于当前对话。', '设计说明.md'],
].map(([category, content, reference], i) => ({ id: `fact-${i}`, category, content, confidence: .8, lastConfirmedAt: new Date().toISOString(), evidence: [{ type: 'file', reference }] })) };
window.refinedFixture = { opened: [], notices: [], reads: [], writes: [], view: null };
window.desktop = { workspace: {
  listTree: async (_, directory) => ({ entries: directory === '.' ? root : [{ name: directory === 'src' ? 'App.jsx' : 'checks.md', path: `${directory}/${directory === 'src' ? 'App.jsx' : 'checks.md'}`, type: 'file' }] }),
  readPreview: async (_, path) => ({ path, content: path.endsWith('.md') ? '# 星河工作台\n\n一个用于展示工作区与项目知识的演示项目。\n\n## 使用方式\n\n- 展开目录查看文件\n- 点击文件阅读内容\n- 在侧栏打开进行编辑\n' : 'export const workspace = {\n  name: "Starlight",\n  theme: "shared",\n};\n', readOnly: false }),
  fileMenu: async request => ({ action: 'preview', path: request.path }),
}, understanding: {
  projects: async () => [{ id: 'legacy', name: '星河工作台' }],
  get: async request => { window.refinedFixture.reads.push(request); return structuredClone(state); },
  setSettings: async request => { window.refinedFixture.writes.push(request); return structuredClone(state); },
} };
function Fixture() {
  const [view, setView] = useState('workspace'), [side, setSide] = useState(false);
  const [task, setTask] = useState({ id: 'refined-demo', workspacePath: 'D:/Demo/Starlight', knowledgeEnabled: true, knowledgeProjectId: 'legacy', messages: [] });
  Object.assign(window.refinedFixture, { view: setView, side: setSide, task: changes => setTask(value => ({ ...value, ...changes })) });
  const notice = value => window.refinedFixture.notices.push(value);
  const workbench = { key: task.id, task, openFile: path => window.refinedFixture.opened.push(path), request: async () => ({ entries: window.refinedFixture.searchEntries || root.filter(item => item.type === 'file'), truncated: false }) };
  const workspace = <FileExplorerPanel embedded workspacePath={task.workspacePath} onNotice={notice} headerActions={<button type="button" className="workspace-anchor-toggle" aria-pressed="false">Anchor</button>}
    {...(side ? { onOpenFile: workbench.openFile } : { renderPreview: (path, revision) => <WorkspaceFilePreview path={path} revision={revision} task={task} workbench={workbench} onNotice={notice} /> })} />;
  const knowledge = <ProjectUnderstandingPanel task={task} onNotice={notice} onUpdateTask={changes => setTask(value => ({ ...value, ...changes }))} onOpenFile={workbench.openFile} />;
  return <WorkbenchContext.Provider value={workbench}><div style={{ height: '100vh', overflow: 'auto', background: 'var(--bg-app)', display: 'flex', flexDirection: 'column' }}>
    {side ? <WorkbenchContent tab={{ kind: view === 'workspace' ? 'workspace' : 'understanding' }} task={task} workbench={workbench} onNotice={notice} builtins={{ workspace, understanding: knowledge }} /> : view === 'workspace' ? <div className="workspace-view-stack">{workspace}</div> : knowledge}
  </div></WorkbenchContext.Provider>;
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>);

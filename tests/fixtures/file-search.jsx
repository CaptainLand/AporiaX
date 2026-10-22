import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { WorkbenchContent } from '../../src/workbench/WorkbenchPanes.jsx';
import '../../src/styles.css';
localStorage.setItem('aporiax.language.v1', 'zh-CN');
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') || 'dark';
const task = { id: 'search-fixture', workspacePath: 'D:/Fixture' };
const workbench = { key: 'search-fixture', task, request: input => window.searchFixture.request(input), openFile: path => window.searchFixture.opened.push(path) };
createRoot(document.getElementById('root')).render(<I18nProvider><div style={{ width: '100%', maxWidth: 560, height: 650, padding: 16 }}>
  <WorkbenchContent tab={{ kind: 'workspace' }} task={task} workbench={workbench} builtins={{ workspace: <div>文件树</div> }} onNotice={() => {}} />
</div></I18nProvider>);

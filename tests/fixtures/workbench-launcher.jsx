import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { WorkbenchContent } from '../../src/workbench/WorkbenchPanes.jsx';
import '../../src/styles.css';
import '../../src/workbench/workbench.css';
const query = new URLSearchParams(location.search);
localStorage.setItem('aporiax.language.v1', query.get('lang') || 'zh-CN');
document.documentElement.dataset.theme = query.get('theme') || 'dark';
window.launcherCalls = [];
const workbench = { task: { workspacePath: query.has('no-workspace') ? '' : 'D:/Fixture' },
  open: kind => window.launcherCalls.push(['open', kind]), create: kind => window.launcherCalls.push(['create', kind]) };
createRoot(document.getElementById('root')).render(<I18nProvider><main className="workbench-body" style={{ width: '100%', height: '100%' }}>
  <WorkbenchContent workbench={workbench} onNeedWorkspace={() => window.launcherCalls.push(['choose-workspace'])} />
</main></I18nProvider>);

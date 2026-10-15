import React from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../src/composer/Composer.jsx';
import { I18nProvider } from '../../src/i18n.jsx';
import '../../src/styles.css';
localStorage.setItem('aporiax.language.v1', 'zh-CN');
window.fixture = { sends: [], calls: [], notices: [] };
window.desktop = {
  attachments: { parse: async input => ({ name: input.name, format: 'TXT', size: input.data.length, content: '演示文件内容' }) },
  workspace: { listTree: async () => { window.fixture.calls.push('files'); return { entries: [{ type: 'file', path: 'README.md' }, { type: 'file', path: '设计/界面说明.md' }] }; } },
  core: {
    skills: async () => { window.fixture.calls.push('skills'); return { skills: [{ name: 'create-professional-role', title: '新建专业角色', description: '描述职责，由 Agent 整理配置并交给你确认' }, { name: 'frontend-review', title: '前端审查', description: '检查界面与交互' }] }; },
    mcp: async () => { window.fixture.calls.push('mcp'); return { servers: [{ id: 'docs', name: '文档工具', transport: 'stdio' }] }; },
  },
  workbench: { request: async input => { window.fixture.calls.push(input.action); return input.action === 'list' ? [{ id: 'browser_1', kind: 'browser', title: '演示页面' }, { id: 'terminal_1', kind: 'terminal', title: '开发终端' }] : null; } },
};
createRoot(document.getElementById('root')).render(<I18nProvider><main style={{ height: '100%', padding: 24, background: 'var(--gray-2)' }}>
  <div style={{ color: 'var(--gray-10)', fontSize: 13 }}>AporiaX · 引用菜单预览</div>
  <div style={{ position: 'absolute', bottom: 30, left: '5%', width: '90%', maxWidth: 760 }}>
    <Composer task={{ id: 'menu-fixture', workspacePath: 'D:/Fixture', providerId: 'fake', modelId: 'test' }}
      providers={[{ id: 'fake', name: 'Fixture', models: [{ id: 'test', name: '演示模型', supportsImages: !location.search.includes('text-only') }] }]}
      onSend={content => { window.fixture.sends.push(content); return true; }} onUpdateTask={() => {}} onNotice={notice => window.fixture.notices.push(notice)} />
  </div></main></I18nProvider>);

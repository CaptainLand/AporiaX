import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { ProfessionalRolesSettings } from '../../src/settings/ProfessionalRolesSettings.jsx';
import { ProfessionalAgentPanel } from '../../src/conversation/ProfessionalAgentPanel.jsx';
import { defaultRoleSettings, normalizeRoleSettings } from '../../shared/professional-roles.js';
import '../../src/styles.css';
localStorage.setItem('aporiax.language.v1', 'zh-CN');
window.fixture = { saved: defaultRoleSettings(), calls: [] };
window.desktop = {
  agentProfiles: {
    get: async () => structuredClone(window.fixture.saved),
    save: async value => { if (window.fixture.rejectSave) throw new Error('Fixture save failure'); const saved = normalizeRoleSettings(value); window.fixture.saved = { ...saved, revision: saved.revision + 1 }; return structuredClone(window.fixture.saved); },
    steer: async value => { window.fixture.calls.push({ kind: 'steer', ...value }); return { status: 'guidance_queued' }; },
    stop: async value => { window.fixture.calls.push({ kind: 'stop', ...value }); return { status: 'cancellation_requested' }; },
  },
  core: { skills: async () => ({ skills: [{ name: 'fixture-skill', title: 'Fixture Skill' }] }), capabilities: async () => ({ capabilities: [{ name: 'mcp__fixture__check', title: 'Fixture check', metadata: { serverName: 'Local fixture' } }] }) },
};
function Fixture() {
  const [task, setTask] = useState({ id: 'fixture', builderLimit: 0 });
  const [active, setActive] = useState(true);
  window.fixture.end = () => setActive(false);
  return <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 20, maxWidth: 1050, margin: '20px auto', padding: 20 }}>
    <ProfessionalRolesSettings task={task} providers={[{ id: 'fixture', name: 'Fixture', models: [{ id: 'specialist', name: 'Specialist' }] }]} onUpdateTask={patch => { window.fixture.task = { ...task, ...patch }; setTask(value => ({ ...value, ...patch })); }} />
    <ProfessionalAgentPanel taskId="fixture" active={active} run={{ runId: 'run-fixture', subagents: [{ agentId: 'agent-fixture', profileName: 'Researcher', task: '核对文件证据', status: 'running', phase: 'model', configuration: { model: 'specialist', tools: ['read_file'], thinking: false }, budget: { requests: 2, tokens: 100, unknown: 1 }, scope: ['src'], summary: '已读取样例文件，等待继续。' }] }} />
  </div>;
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>);

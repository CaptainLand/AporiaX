import React from 'react';
import { createRoot } from 'react-dom/client';
import AgentOffice from '../../src/office/AgentOffice.jsx';
import { I18nProvider, useI18n } from '../../src/i18n.jsx';
import { defaultRoleSettings } from '../../shared/professional-roles.js';
import '../../src/styles.css';
localStorage.setItem('aporiax.language.v1', 'zh-CN');
const roles = defaultRoleSettings();
const old = { explore: '探索', review: '审查', verify: '验证', builder: 'Builder', curator: '知识整理' };
roles.profiles.forEach(role => { role.name = old[role.id]; });
window.desktop = { agentProfiles: { get: async () => structuredClone(roles) } };
const task = { id: 'office-identities', workspacePath: 'D:/Demo/Starlight', messages: [] };
function Fixture() {
  window.officeIdentity = { language: useI18n().setLanguage };
  return <div style={{ height: '100vh', display: 'flex', background: 'var(--bg-app)' }}><AgentOffice task={task} theme="light" onBack={() => {}} onRoute={() => {}} onChat={() => {}} /></div>;
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>);

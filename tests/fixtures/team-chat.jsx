import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, useI18n } from '../../src/i18n.jsx';
import { TeamChatPane } from '../../src/team-chat/TeamChatPane.jsx';
import '../../src/styles.css';
localStorage.setItem('aporiax.language.v1', 'zh-CN');
const subscribers = new Set();
const events = new EventSource('/__team-events');
events.onmessage = event => subscribers.forEach(fn => fn(JSON.parse(event.data)));
window.desktop = { teamChat: { request: async input => {
  const response = await fetch('/__team-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
}, subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn); } } };
window.fixture = { transfers: [] };
const drafts = new Map();
const task = { id: 'demo', title: '演示页面', workspacePath: 'D:/Demo/Team', providerId: 'demo', modelId: 'mock' };
const providers = [{ id: 'demo', name: '演示模型', models: [{ id: 'mock', name: '演示模型' }] }];
const workbench = { draft: key => drafts.get(key), saveDraft: (key, value) => drafts.set(key, value) };
function LocalizedTeam() {
  window.fixture.language = useI18n().setLanguage;
  return <TeamChatPane task={task} tab={{}} workbench={workbench} providers={providers} onSendToMain={async text => window.fixture.transfers.push(text)} />;
}
function Fixture() {
  return <I18nProvider><div id="test-pane" style={{ width: '520px', height: '850px', margin: '20px auto', border: '1px solid var(--border)' }}><LocalizedTeam /></div></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture />);

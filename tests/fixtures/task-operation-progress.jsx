import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { Conversation } from '../../src/conversation/ConversationViews.jsx';
import { createWitnessMonitor } from '../../electron/witness-monitor.js';
import '../../src/styles.css';
localStorage.setItem('aporiax.language.v1', 'zh-CN');
let clock = Date.now();
const monitor = createWitnessMonitor({ heartbeatMs: 0, now: () => clock });
monitor.observe({ type: 'turn.started' }); monitor.observe({ type: 'response.reset', round: 1 });
function Fixture() {
  const [witness, setWitness] = useState(monitor.snapshot());
  const [overrides, setOverrides] = useState({});
  window.witnessProgressState = setOverrides;
  window.operationProgress = (event, elapsedMs = 1200) => { clock += elapsedMs; monitor.observe(event); setWitness(monitor.snapshot()); };
  return <div style={{ maxWidth: 820, margin: '48px auto', padding: '0 24px' }}><Conversation task={{ id: 'progress', messages: [{ id: 'answer', role: 'assistant', status: 'running', content: '', steps: [], changes: [], witness, ...overrides }] }} isRunning onNotice={() => {}} /></div>;
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>);

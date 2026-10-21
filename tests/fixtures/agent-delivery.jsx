import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { WorkbenchContext } from '../../src/workbench/use-workbench.js';
import { ProfessionalAgentPanel } from '../../src/conversation/ProfessionalAgentPanel.jsx';
import { completedReview } from '../agent-delivery-fixtures.mjs';
import '../../src/styles.css';
import '../../src/conversation/route-activity.css';
localStorage.setItem('aporiax.language.v1', 'zh-CN');
window.fixture = { calls: [], reject: false };
window.desktop = { agentProfiles: {
  steer: async request => { if (window.fixture.reject) throw new Error('交办未成功，草稿保留'); window.fixture.calls.push({ kind: 'steer', ...request }); return { status: 'guidance_queued' }; },
  stop: async request => { window.fixture.calls.push({ kind: 'stop', ...request }); return { status: 'cancellation_requested' }; },
} };
function Fixture() {
  const [active, setActive] = useState(true), [worker, setWorker] = useState(structuredClone(completedReview));
  window.fixture.active = setActive;
  window.fixture.worker = patch => setWorker(value => ({ ...value, ...patch }));
  return <WorkbenchContext.Provider value={{ openFile: async (path, line) => window.fixture.calls.push({ kind: 'file', path, line }) }}>
    <main className="route-activity" style={{ maxWidth: 880, padding: 24, margin: '20px auto' }}><ProfessionalAgentPanel taskId="delivery-task" run={{ runId: 'delivery-run', subagents: [worker] }} active={active}
      onContinueAgent={async content => { window.fixture.calls.push({ kind: 'new-followup', content }); return true; }} /></main>
  </WorkbenchContext.Provider>;
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>);

import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { ClarificationCard } from '../../src/conversation/ClarificationCard.jsx';
import { useHarnessEvents } from '../../src/hooks/useHarnessEvents.js';
import '../../src/styles.css';
localStorage.setItem('aporiax.language.v1', 'zh-CN');
let listener;
const initial = { id: 'question', runId: 'run', taskId: 'task', status: 'pending', ordinal: 1, limit: 2,
  question: '这份报告面向谁？', reason: '内部报告可以包含成本，公开报告需要隐藏这些信息。',
  options: [{ id: '1', label: '内部团队', description: '保留成本和实施细节', recommended: true }, { id: '2', label: '公开发布', description: '仅展示可以公开的内容' }] };
const state = { calls: [], fail: false };
window.clarificationFixture = state;
window.desktop = { harness: {
  onEvent: fn => { listener = fn; return () => { listener = null; }; },
  respondToClarification: async value => {
    state.calls.push(value);
    if (state.fail) throw new Error('Simulated disk failure');
    const question = state.question;
    listener({ type: 'clarification.updated', runId: 'run', questions: [{ ...question, status: 'answered',
      answer: { text: value.answer.text || question.options.find(option => option.id === value.answer.optionId).label } }] });
    return { accepted: true };
  },
  interrupt: async () => { state.stopped = true; listener({ type: 'clarification.updated', runId: 'run', questions: [{ ...state.question, status: 'cancelled' }] }); },
} };
function Fixture() {
  const [tasks, setTasks] = useState([{ id: 'task', messages: [{ id: 'assistant', role: 'assistant', clarifications: [initial] }] }]);
  const [active, setActive] = useState(true);
  const runsRef = useRef(new Map([['run', { taskId: 'task', assistantId: 'assistant' }]]));
  useHarnessEvents({ language: 'zh-CN', tr: zh => zh, runsRef, setTasks, setRunPaused: () => {}, setRunStatus: () => {} });
  const question = tasks[0].messages[0].clarifications[0]; state.question = question;
  state.reset = (options = {}) => { state.calls = []; state.stopped = false; state.fail = false; setActive(options.active !== false);
    listener({ type: 'clarification.required', runId: 'run', questions: [{ ...initial, ...options, id: 'question-' + Date.now() }] }); };
  return <main style={{ maxWidth: 760, margin: '32px auto', padding: 16 }}><ClarificationCard key={question.id} question={question} active={active} onRetry={() => { state.retried = true; setActive(true); }} /></main>;
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>);

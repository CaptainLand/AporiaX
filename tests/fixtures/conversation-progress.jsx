import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { Conversation } from '../../src/conversation/ConversationViews.jsx';
import '../../src/styles.css';

localStorage.setItem('aporiax.language.v1', 'zh-CN');
document.documentElement.dataset.theme = 'dark';
const progress = id => ({ id, kind: 'progress', title: '阶段进展', content: `正在处理第 ${id} 项。` });

function Fixture() {
  const [isRunning, setIsRunning] = useState(true);
  const [task, setTask] = useState({ id: 'progress-lifecycle', workspacePath: 'D:/Fixture', messages: [
    { id: 'history', role: 'assistant', status: 'completed', content: '上一轮已完成。', progressUpdates: [progress('history')] },
    { id: 'answer-1', role: 'assistant', status: 'running', content: '正在整理结果。', progressUpdates: [progress('1'), progress('2')] },
  ] });
  const updateLatest = update => setTask(current => ({ ...current,
    messages: current.messages.map((message, index) => index === current.messages.length - 1 ? update(message) : message),
  }));
  const finish = status => {
    updateLatest(message => ({ ...message, status, content: '这一轮已结束。' }));
    setIsRunning(false);
  };
  const start = () => {
    setTask(current => ({ ...current, messages: [...current.messages,
      { id: `answer-${current.messages.length}`, role: 'assistant', status: 'running', content: '', progressUpdates: [] },
    ] }));
    setIsRunning(true);
  };
  return <main style={{ height: '100%', overflow: 'auto', padding: 24 }}>
    <nav style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
      <button onClick={() => updateLatest(message => ({ ...message,
        progressUpdates: [...message.progressUpdates, progress(String(message.progressUpdates.length + 1))],
      }))}>追加进展</button>
      <button onClick={() => updateLatest(message => ({ ...message, content: `${message.content}正在生成正文。` }))}>流式正文</button>
      <button onClick={() => finish('completed')}>完成本轮</button>
      <button onClick={() => finish('failed')}>运行失败</button>
      <button onClick={() => finish('interrupted')}>停止本轮</button>
      <button onClick={() => setIsRunning(false)}>仅停止运行标记</button>
      <button onClick={start}>开始新一轮</button>
    </nav>
    <div style={{ maxWidth: 820, margin: '0 auto' }}><Conversation task={task} isRunning={isRunning} /></div>
  </main>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><I18nProvider><Fixture /></I18nProvider></React.StrictMode>);

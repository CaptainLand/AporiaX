import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Composer } from '../composer/Composer.jsx';
import { Conversation } from '../conversation/ConversationViews.jsx';
import { ConversationSelectionMenu } from '../conversation/ConversationSelectionMenu.jsx';
import { useI18n } from '../i18n';
import './temporary-chat.css';

export function TemporaryChatPane({ task, workbench, providers = [], onManageProviders }) {
  const { tr } = useI18n();
  const [session, setSession] = useState(null), [settings, setSettings] = useState({});
  const [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [quoteRequest, setQuoteRequest] = useState(null);
  const current = useRef(null), scroll = useRef(null), follow = useRef(true), alive = useRef(false);
  const scope = workbench.key;
  const accept = value => {
    if (!value || !alive.current || value.scope !== scope || value.taskId !== task.id) return;
    if (current.current && value.id !== current.current.id) return;
    if (current.current && (value.revision || 0) < (current.current.revision || 0)) return;
    current.current = value; setSession(value);
  };
  const request = async (action, extra = {}) => {
    if (!window.desktop?.sideChat) throw new Error(tr('请在最新版桌面端使用临时聊天。', 'Use temporary chat in the updated desktop app.'));
    return window.desktop.sideChat.request({ action, taskId: task.id, scope, sessionId: current.current?.id, ...extra });
  };
  useEffect(() => {
    alive.current = true; current.current = null; setSession(null); setLoading(true); setError('');
    let disposed = false;
    const off = window.desktop?.sideChat?.subscribe(event => {
      if (!disposed && event.type === 'session' && event.sessionId === current.current?.id) accept(event.session);
    });
    request('open', { history: task.messages }).then(value => {
      if (disposed) return;
      accept(value); setSettings(value.settings);
      workbench.saveDraft('temporary:sessionId', value.id);
    }).catch(cause => { if (!disposed) setError(cause.message); }).finally(() => { if (!disposed) setLoading(false); });
    // Hiding/unmounting the panel preserves the in-memory session. Only an
    // explicit close tab requests cancellation and destruction from the host.
    return () => { disposed = true; alive.current = false; off?.(); };
  }, [scope]);
  useLayoutEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [session]);
  const busy = Boolean(session?.messages.some(message => message.status === 'running'));
  const act = (action, extra) => { setError(''); void request(action, extra).then(value => { if (value?.id) accept(value); }).catch(cause => { if (alive.current) setError(cause.message); }); };
  const send = (message, attachments) => {
    if (loading || !session || session.closing) return false;
    follow.current = true; act('send', { message, attachments, ...settings }); return true;
  };
  const displayTask = { ...task, ...settings, id: session?.id || `temporary-loading-${task.id}`,
    messages: session?.messages || [], workspacePath: session?.workspacePath || task.workspacePath };
  return <section className="temporary-chat side-chat" aria-label={tr('临时聊天', 'Temporary chat')}>
    <div className="temporary-chat-scroll" ref={scroll} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 70; }}>
      {loading ? <p className="temporary-chat-empty">{tr('正在建立临时分支…', 'Opening temporary fork…')}</p> : !displayTask.messages.length ? null :
        <ConversationSelectionMenu onNotice={setError} onQuote={text => setQuoteRequest({ taskId: displayTask.id, text })}>
        <Conversation task={displayTask} isRunning={busy} approval={session?.approval} allowFileActions={false}
          onRespondApproval={approved => act('approve', { approvalId: session?.approval?.id, approved })}
          onRetry={() => { send(tr('继续处理上一条临时要求，先核对当前文件和上次执行结果，不要盲目重复操作。', 'Continue the previous temporary request; inspect current files and previous effects before retrying.'), []); }}
          onNotice={setError} /></ConversationSelectionMenu>}
    </div>
    {error && <p className="temporary-chat-error" role="alert">{error}</p>}
    {session?.closing && <p className="temporary-chat-error" role="status">{tr('正在停止临时执行并清理对话…', 'Stopping temporary execution and discarding chat…')}</p>}
    {!loading && session && <Composer task={displayTask} providers={providers} onSend={send} layoutScope="temporary"
      quoteRequest={quoteRequest}
      initialDraft={workbench.draft('temporary:composer')} onDraftChange={value => workbench.saveDraft('temporary:composer', value)}
      isRunning={busy} isPaused={session.paused} onStop={() => act('cancel')} onPause={() => act('pause')} onResume={() => act('resume')}
      onUpdateTask={patch => setSettings(value => ({ ...value, ...patch }))} onNotice={setError} onManageProviders={onManageProviders} />}
  </section>;
}

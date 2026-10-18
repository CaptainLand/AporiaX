import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ArrowUp, AtSign, BriefcaseBusiness, Check, MoreHorizontal, Search, Square, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getAvailableModels } from '../models/model-catalog.js';
import { SideChatModelPicker } from '../workbench/SideChatModelPicker.jsx';
import { SideChatDialog } from '../workbench/SideChatDialog.jsx';
import { teamDisplayInfo, teamRecipients, ALL_TEAM_MEMBERS } from '../../shared/team-chat.js';
import { agentAliases, agentDisplayName, agentChatDisplayName } from '../../shared/agent-identity.js';
import { useI18n } from '../i18n';
import '../workbench/side-chat.css';
import './team-chat.css';
import { AgentAvatar } from '../components/AgentAvatar.jsx';
import { AgentTeamAvatar } from '../components/AgentTeamAvatar.jsx';
import { MemberJobDialogs } from './MemberJobDialogs.jsx';

function Face({ role, group }) {
  if (group) return <AgentTeamAvatar className="tm-avatar tm-group" />;
  return <AgentAvatar template={role?.template || role?.id || 'main'} className="tm-avatar" />;
}
const totalTokens = usage => Number.isFinite(usage?.total_tokens) ? usage.total_tokens : Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens) ? usage.prompt_tokens + usage.completion_tokens : null;

export function TeamChatPane({ task, tab, workbench, providers = [], onSendToMain, onManageProviders }) {
  const { tr, language } = useI18n();
  const [rawInfo, setInfo] = useState(null), [roomId, setRoomId] = useState(tab.roomId || '');
  const info = useMemo(() => teamDisplayInfo(rawInfo, language), [rawInfo, language]);
  const messageName = message => agentChatDisplayName({ roleId: message.roleId, name: message.name }, language);
  const [room, setRoom] = useState(null), [contextId, setContextId] = useState(task.id);
  const [query, setQuery] = useState(''), [draft, setDraft] = useState(''), [recipients, setRecipients] = useState([]);
  const [error, setError] = useState(''), [syncError, setSyncError] = useState(''), [notice, setNotice] = useState(''), [pending, setPending] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false), [dialog, setDialog] = useState(null), [transfer, setTransfer] = useState(''), [transferring, setTransferring] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [jobs, setJobs] = useState([]), [jobTarget, setJobTarget] = useState('main'), [jobText, setJobText] = useState(''), [jobDraft, setJobDraft] = useState(null), [jobBusy, setJobBusy] = useState(false), [jobError, setJobError] = useState('');
  const [selected, setSelected] = useState(() => workbench.draft('teamchat:model') || '');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchButtonRef = useRef(null);
  const current = useRef({}), listRef = useRef(null), inputRef = useRef(null), follow = useRef(true), mounted = useRef(true), loadGeneration = useRef(0);
  current.current = { taskId: task.id, contextId, roomId, key: info?.projectKey };
  const request = (action, extra = {}) => {
    if (!window.desktop?.teamChat) return Promise.reject(new Error('请重启最新版 AporiaX 后使用团队消息。'));
    return window.desktop.teamChat.request({ action, taskId: task.id, contextTaskId: contextId, roomId, language, ...extra });
  };
  const refreshJobs = async () => {
    const captured = { taskId: task.id, roomId };
    const value = await request('jobs:list');
    if (mounted.current && current.current.taskId === captured.taskId && current.current.roomId === captured.roomId) setJobs(value);
  };
  const options = useMemo(() => getAvailableModels(providers).map(m => ({ ...m, modelId: m.id, value: JSON.stringify([m.providerId, m.id]) })), [providers]);
  const choice = selected ? options.find(m => m.value === selected) : task.providerId && task.modelId ? options.find(m => m.providerId === task.providerId && m.id === task.modelId) : options.find(m => !m.disabled);
  const summary = info?.rooms.find(r => r.id === roomId);
  const profile = info?.roles.find(r => roomId === 'role:' + r.id);
  const group = roomId === 'group', locked = summary?.archived || summary?.disabled;
  const busy = pending === roomId || summary?.busy || room?.messages.some(m => m.status === 'running');
  const validRoom = room?.id === roomId;
  const stateLabel = worker => ({ running: tr('执行中', 'Working'), completed: tr('已完成', 'Completed'), failed: tr('失败', 'Failed'), interrupted: tr('已停止', 'Stopped'), queued: tr('等待中', 'Queued'), waiting: tr('等待中', 'Waiting') }[worker.status] || tr('最后已知记录', 'Last known record'));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setMentionIndex(0); }, [mentionOpen, draft]);
  useEffect(() => { setRoomId(tab.roomId || ''); setContextId(task.id); }, [tab.revision]);
  useEffect(() => {
    let alive = true, timer, sequence = 0;
    const refresh = async () => {
      const generation = ++sequence;
      try {
        const value = await request('list');
        if (alive && generation === sequence) { setInfo(value); setSyncError(''); }
      } catch (e) { if (alive && generation === sequence) setSyncError(e.message); }
      if (alive && generation === sequence) timer = setTimeout(refresh, 3000);
    };
    void refresh();
    const rolesChanged = () => { clearTimeout(timer); void refresh(); };
    window.addEventListener('aporiax:roles-updated', rolesChanged);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener('aporiax:roles-updated', rolesChanged); };
  }, [task.id, contextId]);
  useEffect(() => {
    const generation = ++loadGeneration.current;
    setRoom(null); setError(''); setNotice(''); setDialog(null); setMentionOpen(false); setRecipients([]); follow.current = true;
    setDraft(workbench.draft('teamchat:draft:' + roomId) || '');
    if (!roomId) return;
    request('load').then(value => {
      if (mounted.current && generation === loadGeneration.current) setRoom(previous => previous?.sequence > value.sequence ? previous : value);
    }).catch(e => { if (mounted.current && generation === loadGeneration.current) setError(e.message); });
  }, [task.id, roomId]);
  useEffect(() => {
    setJobs([]); setJobDraft(null); setJobError('');
    if (!roomId) return;
    let alive = true;
    const refresh = () => { if (alive) void refreshJobs().catch(e => { if (alive) setJobError(e.message); }); };
    refresh(); const timer = setInterval(refresh, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [task.id, roomId]);
  useEffect(() => window.desktop?.teamChat?.subscribe(event => {
    if (event.projectKey !== current.current.key) return;
    if (event.type === 'member-jobs.updated') return;
    if (!event.room) return;
    setInfo(previous => previous ? { ...previous, rooms: previous.rooms.map(r => r.id === event.roomId ? {
      ...r, preview: event.room.messages.at(-1)?.content || event.room.messages.at(-1)?.error || '', updatedAt: event.room.messages.at(-1)?.createdAt,
      busy: event.room.messages.some(m => m.status === 'running'),
      unread: event.room.messages.filter(m => m.role !== 'user' && m.status !== 'running' && m.sequence > event.room.readSequence).length,
    } : r) } : previous);
    if (event.roomId === current.current.roomId) setRoom(event.room);
  }), []);
  useEffect(() => {
    if (validRoom && follow.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [room]);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = Math.min(132, input.scrollHeight) + 'px';
  }, [draft, roomId, locked]);
  useEffect(() => {
    if (!validRoom) return;
    const read = () => {
      if (document.visibilityState !== 'visible') return;
      request('read', { sequence: room.sequence }).then(() => {
        if (mounted.current) setInfo(p => p ? { ...p, rooms: p.rooms.map(r => r.id === room.id ? { ...r, unread: 0 } : r) } : p);
      }).catch(e => { if (mounted.current) setError(e.message); });
    };
    read(); document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
  }, [roomId, room?.sequence]);
  const changeDraft = value => { setDraft(value); workbench.saveDraft('teamchat:draft:' + roomId, value); };
  const chooseMention = id => {
    setRecipients(previous => id === ALL_TEAM_MEMBERS ? [ALL_TEAM_MEMBERS] : previous.includes(id) ? previous : [...previous.filter(p => p !== ALL_TEAM_MEMBERS), id]);
    changeDraft(draft.replace(/(?:^|\s)@[^\s@]*$/u, '')); setMentionOpen(false); inputRef.current?.focus();
  };
  async function send(event) {
    event.preventDefault();
    if (busy || locked || !choice || choice.disabled || !draft.trim() || !validRoom) return;
    const captured = { taskId: task.id, roomId }, content = draft.trim();
    try {
      const targets = group ? teamRecipients(content, recipients, info.roles) : [];
      setPending(roomId); setError(''); follow.current = true;
      const value = await request('send', { message: content, recipients: targets, requestId: crypto.randomUUID(), providerId: choice.providerId, modelId: choice.modelId });
      workbench.saveDraft('teamchat:draft:' + captured.roomId, '');
      if (mounted.current && current.current.taskId === captured.taskId && current.current.roomId === captured.roomId) {
        setRoom(value); changeDraft(''); setRecipients([]);
      }
    } catch (e) { if (mounted.current && current.current.roomId === captured.roomId) setError(e.message); }
    finally { if (mounted.current) setPending(''); }
  }
  const stop = async () => { try { await request('cancel'); } catch (e) { setError(e.message); } };
  const openJob = (message = null) => {
    setJobTarget(profile?.id || message?.roleId || (recipients.length === 1 && recipients[0] !== ALL_TEAM_MEMBERS ? recipients[0] : 'main'));
    setJobText(message?.role === 'user' ? message.content : draft);
    setJobDraft(null); setJobError(''); setDialog({ kind: 'job' });
  };
  async function prepareJob() {
    if (!choice || jobBusy) return;
    setJobBusy(true); setJobError('');
    try { setJobDraft(await request('jobs:prepare', { roleId: jobTarget, instruction: jobText, providerId: choice.providerId, modelId: choice.modelId })); }
    catch (e) { setJobError(e.message); }
    finally { if (mounted.current) setJobBusy(false); }
  }
  async function jobAction(action, job, extra = {}) {
    setJobBusy(true); setJobError('');
    try { await request(action, { jobId: job.id, ...extra }); await refreshJobs(); if (action === 'jobs:start') { setJobDraft(null); setDialog({ kind: 'jobs' }); } }
    catch (e) { setJobError(e.message); }
    finally { if (mounted.current) setJobBusy(false); }
  }
  const jobStatus = status => ({ draft: tr('待确认', 'Draft'), queued: tr('排队中', 'Queued'), running: tr('执行中', 'Working'), waiting_approval: tr('等待审批', 'Approval needed'), completed: tr('已完成', 'Completed'), cancelled: tr('已取消', 'Cancelled'), failed: tr('未能完成', 'Failed'), needs_attention: tr('需要处理', 'Needs attention') }[status] || status);
  const openTransfer = message => {
    setTransfer((message.roleId ? tr('请主管结合 {name} 的建议协调后续工作：\n', 'Please coordinate next steps using {name}’s suggestions:\n', { name: messageName(message) }) : '') + message.content);
    setDialog({ kind: 'transfer' });
  };
  async function confirmTransfer() {
    if (!transfer.trim() || !onSendToMain || contextId !== task.id) return;
    setTransferring(true); setError('');
    try {
      await onSendToMain(transfer.trim());
      if (mounted.current) { setDialog(null); setNotice(tr('已交给当前任务主管协调。', 'Sent to the current task supervisor.')); }
    } catch (e) { if (mounted.current) setError(e.message); }
    finally { if (mounted.current) setTransferring(false); }
  }
  const markdown = { a: ({ children }) => <span>{children}</span>, img: ({ alt }) => <span>{alt}</span> };
  const mentions = info?.roles.filter(r => r.enabled && agentAliases(r).join(' ').toLowerCase().includes((draft.match(/@([^\s@]*)$/u)?.[1] || '').toLowerCase())) || [];
  const mentionChoices = [{ id: ALL_TEAM_MEMBERS }, ...mentions];
  const composerKeyDown = e => {
    if (e.nativeEvent.isComposing) return;
    if (mentionOpen && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter'].includes(e.key) && !e.shiftKey) {
      e.preventDefault();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setMentionIndex(index => (index + (e.key === 'ArrowDown' ? 1 : -1) + mentionChoices.length) % mentionChoices.length);
      else chooseMention(mentionChoices[mentionIndex % mentionChoices.length].id);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form.requestSubmit(); }
    if (e.key === 'Escape') setMentionOpen(false);
  };
  return <section className="team-chat" data-room={roomId} aria-label={tr('团队消息', 'Team messages')}>
    <header className="tm-header">
      {roomId && <><button className="tm-icon" onClick={() => setRoomId('')} aria-label={tr('返回会话列表', 'Back to conversations')}><ChevronLeft size={20} /></button><Face role={profile} group={group} /></>}
      <strong>{roomId ? summary?.title || room?.title || tr('聊天', 'Chat') : tr('团队消息', 'Team messages')}</strong>
      {roomId ? <><button className="tm-icon tm-jobs-trigger" aria-label={tr('成员独立任务', 'Member jobs')} title={tr('成员独立任务', 'Member jobs')} onClick={() => { setJobError(''); setDialog({ kind: 'jobs' }); }}><BriefcaseBusiness size={18} />{jobs.some(j => ['running', 'waiting_approval', 'queued'].includes(j.status)) && <i />}</button><button className="tm-icon" aria-label={tr('聊天设置', 'Chat settings')} title={tr('聊天设置', 'Chat settings')} aria-haspopup="dialog" onClick={() => setDialog({ kind: 'settings' })}><MoreHorizontal size={20} /></button></>
        : <button ref={searchButtonRef} className="tm-icon" aria-label={tr('搜索会话', 'Search chats')} aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); setQuery(''); }}>{searchOpen ? <X size={18} /> : <Search size={18} />}</button>}
    </header>
    {error && <p className="tm-error" role="alert">{error}</p>}
    {syncError && <p className="tm-error" role="alert">{syncError}</p>}
    {notice && <p className="tm-notice" role="status"><Check size={13} />{notice}</p>}
    {!roomId ? <>
      {searchOpen && <label className="tm-search"><Search size={15} /><input autoFocus aria-label={tr('搜索角色和会话', 'Search conversations')} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); setSearchOpen(false); searchButtonRef.current?.focus(); } }} placeholder={tr('搜索角色和会话', 'Search conversations')} /></label>}
      <div className="tm-rooms">{!info && <p className="tm-empty">{tr('正在读取团队…', 'Loading team…')}</p>}{info?.rooms.filter(r => (r.title + r.preview).toLowerCase().includes(query.toLowerCase())).map(r => {
        const role = info.roles.find(p => r.id === 'role:' + p.id);
        return <button className="tm-room" key={r.id} onClick={() => setRoomId(r.id)}>
          <Face role={role} group={r.id === 'group'} /><span className="tm-room-text"><b>{r.title}</b>{r.preview && <small>{r.preview}</small>}</span>
          {r.unread > 0 && <em className="tm-unread" aria-label={tr('未读消息', 'Unread messages')}>{r.unread}</em>}
        </button>;
      })}</div>
    </> : <>
      <div className="tm-history" ref={listRef} onScroll={e => { follow.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 70; }}>
        {!validRoom ? <p className="tm-empty">{tr('正在读取消息…', 'Loading messages…')}</p> : !room.messages.length ? <div className="tm-empty tm-welcome"><Face role={profile} group={group} /><h3>{summary?.title}</h3></div> : room.messages.map(m => <article className={`tm-message tm-${m.role}`} data-status={m.status} aria-label={m.role === 'user' ? tr('你的消息', 'Your message') : m.role === 'assistant' ? messageName(m) : tr('系统消息', 'System message')} key={m.id}>
          {m.role === 'assistant' && <Face role={info?.roles.find(r => r.id === m.roleId) || { id: m.roleId, template: m.roleTemplate || m.roleId }} />}
          <div className="tm-message-body">
            {group && m.role === 'assistant' && <b className="tm-sender">{messageName(m)}</b>}
            <div className={`tm-bubble${m.mentions?.some(mention => mention.type === 'user') ? ' tm-mentioned-user' : ''}`}>{!m.content && m.status === 'running' ? <span className="tm-typing" role="status" aria-label={tr('等待回复', 'Waiting for a reply')}><i /><i /><i /></span> : <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdown}>{m.content || ''}</ReactMarkdown>}{m.error && <p className="tm-error">{m.error}</p>}{m.memberJobId && <button type="button" className="tm-report-detail" onClick={() => setDialog({ kind: 'jobs' })}>{tr('查看独立任务', 'View member job')}</button>}{m.jobProposal && <button type="button" className="tm-report-detail" onClick={() => { setJobDraft(m.jobProposal); setJobError(''); setDialog({ kind: 'job' }); }}>{tr('确认独立任务', 'Review independent job')}</button>}</div>
            {m.role === 'user' && group && m.recipients?.length > 0 && <small className="tm-receivers">{m.recipients.map(id => '@' + (info?.roles.find(r => r.id === id)?.name || id)).join(' ')}</small>}
          </div>
          {m.role !== 'system' && m.status !== 'running' && <button className="tm-icon tm-message-more" aria-label={tr('消息选项', 'Message options')} aria-haspopup="dialog" title={tr('消息选项', 'Message options')} onClick={() => setDialog({ kind: 'message', message: m })}><MoreHorizontal size={17} /></button>}
        </article>)}
      </div>
      {locked ? <p className="tm-empty">{tr('角色已删除或停用，历史只读。', 'Role deleted or disabled. History is read-only.')}</p> : <form className="tm-compose" onSubmit={send}>
        {group && recipients.length > 0 && <div className="tm-recipients">{recipients.map(id => <button type="button" key={id} disabled={busy} aria-label={tr('移除回复角色', 'Remove respondent') + ' ' + (id === ALL_TEAM_MEMBERS ? tr('全体成员', 'Everyone') : info?.roles.find(r => r.id === id)?.name || id)} onClick={() => setRecipients(recipients.filter(r => r !== id))}>@{id === ALL_TEAM_MEMBERS ? tr('全体成员', 'Everyone') : info?.roles.find(r => r.id === id)?.name || id}<X size={12} /></button>)}</div>}
        {group && mentionOpen && <div className="tm-mentions" role="group" aria-label={tr('选择回复角色', 'Choose respondents')}><button type="button" data-active={mentionIndex === 0} onClick={() => chooseMention(ALL_TEAM_MEMBERS)}><Face group /><span>{tr('全体成员', 'Everyone')}</span>{recipients.includes(ALL_TEAM_MEMBERS) && <Check size={14} />}</button>{mentions.map((r, index) => <button type="button" key={r.id} data-active={mentionIndex === index + 1} onClick={() => chooseMention(r.id)}><Face role={r} /><span>{r.name}</span>{recipients.includes(r.id) && <Check size={14} />}</button>)}</div>}
        <div className="tm-compose-row">
          {group && <button type="button" className="tm-icon tm-mention-trigger" aria-label={tr('邀请角色', 'Invite roles')} title={tr('邀请角色（默认主管回复）', 'Invite roles (supervisor replies by default)')} aria-expanded={mentionOpen} onClick={() => setMentionOpen(!mentionOpen)} disabled={busy}><AtSign size={19} /></button>}
          <button type="button" className="tm-icon" aria-label={tr('派发独立任务', 'Assign member job')} title={tr('派发独立任务，不影响主任务', 'Assign independently of the main task')} onClick={() => openJob()} disabled={!choice}><BriefcaseBusiness size={18} /></button>
          <textarea ref={inputRef} rows={1} aria-label={tr('团队聊天消息', 'Team chat message')} value={draft} disabled={busy} maxLength={8000} placeholder={group ? tr('发消息，或 @角色', 'Message or @ a role') : tr('发消息…', 'Message…')} onChange={e => { changeDraft(e.target.value); if (group) setMentionOpen(/(?:^|\s)@[^\s@]*$/u.test(e.target.value)); }} onKeyDown={composerKeyDown} />
          {busy ? <button type="button" className="tm-send" aria-label={tr('停止聊天回复', 'Stop chat reply')} onClick={stop}><Square size={14} /></button> : <button className="tm-send" type="submit" aria-label={tr('发送团队消息', 'Send team message')} disabled={!draft.trim() || !choice || choice.disabled || !validRoom}><ArrowUp size={20} /></button>}
        </div>
        {(!choice || choice.disabled) && <button type="button" className="tm-configure" onClick={() => setDialog({ kind: 'settings' })}>{tr('选择聊天模型', 'Choose a chat model')}</button>}
      </form>}
    </>}
    {dialog?.kind === 'settings' && <SideChatDialog className="tm-dialog tm-settings" title={tr('聊天设置', 'Chat settings')} onClose={() => setDialog(null)}>
      <label className="tm-setting"><span>{tr('工作背景', 'Work context')}</span><select aria-label={tr('选择工作背景', 'Select work context')} value={contextId} disabled={busy} onChange={e => setContextId(e.target.value)}>{(info?.tasks || [{ id: task.id, title: task.title }]).map(t => <option key={t.id} value={t.id}>{t.title || t.id}</option>)}</select></label>
      <div className="tm-setting"><span>{tr('聊天模型', 'Chat model')}</span><SideChatModelPicker providers={providers} options={options} choice={choice} disabled={Boolean(busy)} onSelect={value => { setSelected(value); workbench.saveDraft('teamchat:model', value); }} onManageProviders={onManageProviders ? () => { setDialog(null); onManageProviders(); } : undefined} /></div>
      <p className="tm-setting-note">{tr('独立聊天，不打断任务。回复会使用所选模型的额度；群聊默认由主管回复，@ 可邀请其他角色。', 'Independent chat does not interrupt work. Replies use the selected model’s quota. The supervisor replies to the group by default; @ invites other roles.')}</p>
    </SideChatDialog>}
    {dialog?.kind === 'message' && <SideChatDialog className="tm-dialog tm-message-menu" title={tr('消息选项', 'Message options')} onClose={() => setDialog(null)}>
      <div className="tm-message-identity">{dialog.message.role === 'assistant' && <Face role={info?.roles.find(r => r.id === dialog.message.roleId) || { id: dialog.message.roleId || 'main' }} />}<p className="tm-message-details">{dialog.message.role === 'user' ? tr('你', 'You') : messageName(dialog.message)}<br /><time>{new Date(dialog.message.createdAt).toLocaleString()}</time>{dialog.message.modelId && <><br />{dialog.message.modelId} · {totalTokens(dialog.message.usage) ?? '—'} tokens</>}</p></div>
      {dialog.message.evidence && <button className="tm-menu-action" onClick={() => setDialog({ kind: 'evidence', message: dialog.message })}>{tr('工作依据与用量', 'Evidence & usage')}</button>}
      {dialog.message.content && <button className="tm-menu-action tm-transfer" disabled={contextId !== task.id || !onSendToMain} onClick={() => openTransfer(dialog.message)}>{tr('转为工作要求', 'Turn into work instructions')}</button>}
      {!locked && <button className="tm-menu-action" onClick={() => openJob(dialog.message)}>{tr('交给成员独立处理', 'Assign to a member independently')}</button>}
      {contextId !== task.id && <p className="tm-setting-note">{tr('转交前，请在聊天设置中选择当前任务作为工作背景。', 'To hand off work, select the current task in chat settings first.')}</p>}
    </SideChatDialog>}
    {dialog?.kind === 'evidence' && <SideChatDialog className="tm-dialog" title={tr('工作依据与用量', 'Evidence & usage')} onClose={() => setDialog(null)}>
      <p>{dialog.message.taskTitle} · {tr('采集于', 'Captured at')} {new Date(dialog.message.evidence.capturedAt).toLocaleString()}</p>
      <p>{tr('独立聊天引用工作记录，不是工作者的实时内部思考。', 'An independent chat using work records, not a worker’s internal thoughts.')}</p>
      <dl className="tm-usage"><dt>Tokens</dt><dd>{totalTokens(dialog.message.usage) ?? tr('服务未返回', 'Not reported')}</dd><dt>{tr('首字耗时', 'First token')}</dt><dd>{dialog.message.firstTokenAt ? ((Date.parse(dialog.message.firstTokenAt) - Date.parse(dialog.message.createdAt)) / 1000).toFixed(1) + 's' : '—'}</dd><dt>{tr('总耗时', 'Duration')}</dt><dd>{dialog.message.completedAt ? ((Date.parse(dialog.message.completedAt) - Date.parse(dialog.message.createdAt)) / 1000).toFixed(1) + 's' : '—'}</dd><dt>{tr('费用', 'Cost')}</dt><dd>{tr('无可靠计价，额度以服务端为准', 'No verified price; quota is recorded by your provider')}</dd></dl>
      {dialog.message.evidence.workers.map(w => <div key={w.id} className="tm-evidence"><div className="tm-evidence-heading"><Face role={info?.roles.find(role => role.id === (w.roleId || w.profileId)) || { id: w.template || w.role || w.roleId || w.profileId || 'explore' }} /><b>{agentDisplayName(w, language)} · {stateLabel(w)}</b></div><p>{w.task}</p><p>{w.summary}</p><small>{w.id}</small></div>)}
      {dialog.message.evidence.records.map(r => <div key={r.id} className="tm-evidence"><b>{r.title}</b><p>{r.detail}</p><small>{r.timestamp}</small></div>)}
      {!dialog.message.evidence.workers.length && !dialog.message.evidence.records.length && <p>{tr('此角色在所选任务中暂无工作记录。', 'No work records for this role in the selected task.')}</p>}
    </SideChatDialog>}
    {dialog?.kind === 'transfer' && <SideChatDialog className="tm-dialog" title={tr('转为工作要求', 'Turn into work instructions')} subtitle={tr('确认后交给当前任务的主管协调；可能执行操作并消耗工作额度。', 'Confirmation sends instructions to this task’s supervisor and may run tools and use quota.')} onClose={() => { if (!transferring) setDialog(null); }} footer={<><button type="button" disabled={transferring} onClick={() => setDialog(null)}>{tr('取消', 'Cancel')}</button><button type="button" disabled={transferring || !transfer.trim()} onClick={confirmTransfer}>{transferring ? tr('提交中…', 'Sending…') : tr('确认交给主管', 'Confirm and send')}</button></>}>
      <p>{task.title}</p><textarea className="tm-transfer-editor" aria-label={tr('工作要求', 'Work instructions')} value={transfer} maxLength={8000} disabled={transferring} onChange={e => setTransfer(e.target.value)} />
      {error && <p role="alert">{error}</p>}
    </SideChatDialog>}
    <MemberJobDialogs kind={dialog?.kind} onClose={() => { if (!jobBusy) setDialog(null); }} tr={tr} roles={info?.roles || []} group={group} profile={profile}
      target={jobTarget} setTarget={setJobTarget} text={jobText} setText={setJobText} draft={jobDraft} setDraft={setJobDraft} jobs={jobs}
      workspacePath={task.workspacePath} busy={jobBusy} error={jobError} setError={setJobError} prepare={prepareJob} act={jobAction} statusLabel={jobStatus} openNew={() => openJob()} />
  </section>;
}

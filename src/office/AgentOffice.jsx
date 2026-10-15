import React, { useEffect, useRef, useState } from 'react';
import { Armchair, ArrowLeft, ChevronLeft, ChevronRight, Focus, List, MessagesSquare, Minus, Pause, Play, Plus, RotateCcw, Square, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { buildOfficeModel, latestOfficeRun, officePageRoster } from './office-model.js';
import './office.css';
import { AgentAvatar } from '../components/AgentAvatar.jsx';

function Avatar({ agent }) {
  return <AgentAvatar template={agent.role} className="ao-avatar" />;
}

export default function AgentOffice({ task, isRunning, isPaused, approval, theme, onBack, onRoute, onSend, onStop, onPause, onResume, onChat }) {
  const { tr, language } = useI18n();
  const stage = useRef(null), world = useRef(null), current = useRef(null), view = useRef(null);
  const [settings, setSettings] = useState(null), [settingsError, setSettingsError] = useState('');
  const [snapshot, setSnapshot] = useState(null), [syncError, setSyncError] = useState('');
  const [selected, setSelected] = useState(null), [zone, setZone] = useState(0);
  const [ready, setReady] = useState(false), [sceneError, setSceneError] = useState(''), [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState(100), [pausedAnimation, setPausedAnimation] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [guidance, setGuidance] = useState(''), [pending, setPending] = useState(false), [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now);
  const run = latestOfficeRun(task);
  const runId = run?.runId || null;
  let modelError = '';
  let model;
  try { model = buildOfficeModel({ task, isRunning, isPaused, approval, settings, snapshot, language }); }
  catch (error) { modelError = error.message; model = buildOfficeModel({ task, isRunning, isPaused, approval, language }); }
  const pages = Math.max(1, Math.ceil((model.roster.length - 1) / 5));
  const page = Math.min(zone, pages - 1);
  const roster = officePageRoster(model.roster, page);
  const topology = JSON.stringify(roster.map(a => [a.id, a.color, a.accessory, a.x, a.z, a.angle]));
  const agent = model.roster.find(a => a.id === selected);
  current.current = { roster, model, theme, pausedAnimation, selected, run };

  useEffect(() => {
    let active = true, generation = 0;
    const load = async () => {
      const sequence = ++generation;
      try {
        if (!window.desktop?.agentProfiles?.get) throw new Error(tr('当前桌面版本无法读取专业角色配置。', 'This desktop version cannot read role settings.'));
        const value = await window.desktop.agentProfiles.get();
        if (!active || sequence !== generation) return;
        setSettings(value); setSettingsError(value.error || '');
      } catch (error) { if (active && sequence === generation) setSettingsError(error.message); }
    };
    void load(); window.addEventListener('aporiax:roles-updated', load);
    return () => { active = false; window.removeEventListener('aporiax:roles-updated', load); };
  }, [task.id, tr]);

  // Existing runtime controls expose a read-only snapshot. Poll only this live
  // task while its office is mounted and visible; never launch a model request.
  useEffect(() => {
    setSnapshot(null); setSyncError('');
    if (!model.live || !runId || !window.desktop?.agentProfiles?.list) return;
    let active = true, timer, inFlight = false;
    const poll = async () => {
      if (!active || document.hidden || inFlight) return;
      inFlight = true;
      const baseWorkers = current.current.run?.subagents;
      try {
        const workers = await window.desktop.agentProfiles.list({ taskId: task.id, runId });
        if (active && Array.isArray(workers)) { setSnapshot({ runId, workers, baseWorkers }); setSyncError(''); }
      } catch (error) { if (active) { setSnapshot(null); setSyncError(error.message); } }
      finally { inFlight = false; if (active && !document.hidden) timer = setTimeout(poll, 1800); }
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', visibility); void poll();
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [task.id, runId, model.live]);

  useEffect(() => {
    if (!model.live) return;
    const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, [model.live]);

  useEffect(() => {
    setSelected(null); setGuidance(''); setPending(false); setNotice(''); setZone(0); view.current = null;
  }, [task.id, runId, run?.id]);
  useEffect(() => { setGuidance(''); setNotice(''); }, [selected]);
  useEffect(() => {
    const escape = event => { if (event.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const element = stage.current;
    setReady(false); setSceneError('');
    const onError = event => { setReady(false); setSceneError(event.detail); };
    element.addEventListener('office-error', onError);
    import('./office-scene.js').then(({ createOffice }) => {
      if (cancelled) return;
      try {
        const office = createOffice(element, current.current.roster, {
          onSelect: setSelected, onView: setZoom,
          labels: { canvas: tr('可拖动和缩放的办公室场景', 'Interactive office scene'), agent: a => tr('查看 {name} 的工位', 'View {name} workstation', { name: a.name }), contextLost: tr('图形上下文暂时不可用，请重试场景。', 'Graphics context unavailable. Retry the scene.') },
        });
        world.current = office;
        office.setTheme(current.current.theme === 'dark' ? 'night' : 'day');
        office.setPaused(current.current.pausedAnimation);
        office.setStates(Object.fromEntries(current.current.roster.map(a => [a.id, a.state])));
        office.setMetadata(current.current.roster);
        office.select(current.current.selected);
        office.restoreView(view.current);
        setReady(true);
      } catch (error) { setSceneError(tr('3D 场景无法启动，可继续使用下方角色列表。', 'The 3D scene could not start. The agent list is still available.')); console.warn('Agent office renderer unavailable', error.message); }
    }).catch(error => { if (!cancelled) setSceneError(error.message); });
    return () => {
      cancelled = true; element.removeEventListener('office-error', onError);
      if (world.current) { view.current = world.current.view(); world.current.destroy(); world.current = null; }
    };
  }, [topology, language, retry]);
  useEffect(() => { world.current?.setTheme(theme === 'dark' ? 'night' : 'day'); }, [theme]);
  useEffect(() => { world.current?.setPaused(pausedAnimation); }, [pausedAnimation]);
  useEffect(() => { world.current?.setMetadata(roster); world.current?.setStates(Object.fromEntries(roster.map(a => [a.id, a.state]))); });
  useEffect(() => { world.current?.select(selected); }, [selected, ready]);

  function selectAgent(item) {
    const index = model.roster.findIndex(a => a.id === item.id);
    if (index > 0) setZone(Math.floor((index - 1) / 5));
    setSelected(item.id);
  }
  async function action(kind) {
    if (!agent || pending) return;
    const captured = { taskId: task.id, runId, agentId: agent.agentId, id: agent.id };
    setPending(true); setNotice('');
    try {
      if (!current.current.model.live) throw new Error(tr('本轮已结束。', 'This run has ended.'));
      if (agent.id === 'lead') {
        const result = kind === 'steer' ? await onSend?.(guidance.trim(), [], { taskId: task.id }) : kind === 'stop' ? await onStop?.() : kind === 'pause' ? await onPause?.() : await onResume?.();
        if (result === false) throw new Error(tr('操作未执行，请返回对话查看提示。', 'The action was not applied. Check chat for details.'));
      } else {
        if (!agent.controllable || !window.desktop?.agentProfiles?.[kind]) throw new Error(tr('这个 Agent 当前不可操作。', 'This agent is not currently controllable.'));
        await window.desktop.agentProfiles[kind]({ taskId: task.id, runId, agentId: agent.agentId, ...(kind === 'steer' ? { task: guidance.trim() } : {}) });
      }
      if (current.current.model.runId === captured.runId && current.current.selected === captured.id) {
        if (kind === 'steer') setGuidance('');
        setNotice(kind === 'steer' ? tr('追加要求已提交。', 'Additional instructions sent.') : tr('操作请求已提交，等待运行状态更新。', 'Action requested; waiting for the runtime state to update.'));
      }
    } catch (error) { if (current.current.model.runId === captured.runId && current.current.selected === captured.id) setNotice(error.message); }
    finally { if (current.current.model.runId === captured.runId) setPending(false); }
  }
  const elapsed = agent ? agent.elapsedMs ?? (agent.startedAt ? Math.max(0, (model.live && (agent.id === 'lead' || agent.controllable) ? now : Date.parse(agent.completedAt)) - Date.parse(agent.startedAt)) : null) : null;
  const formatElapsed = Number.isFinite(elapsed) ? elapsed > 60000 ? `${Math.floor(elapsed / 60000)}m ${Math.floor(elapsed / 1000) % 60}s` : `${Math.floor(elapsed / 1000)}s` : '—';
  const tokens = agent?.budget?.tokens ?? agent?.usage?.total_tokens;
  const canControl = agent && model.live && (agent.id === 'lead' || agent.controllable);

  return <section className="agent-office" aria-label={tr('Agent 工位', 'Agent office')}>
    <header className="ao-toolbar"><div><Armchair size={17} /><strong>{tr('Agent 工位', 'Agent office')}</strong><span className={`ao-dot ${model.live ? 'working' : 'sleeping'}`} /><small>{model.live ? tr('实时同步', 'Live') : tr('最近一轮', 'Latest run')}</small></div><div>{onChat && <button onClick={() => onChat()} aria-label={tr('团队消息', 'Team messages')}><MessagesSquare size={15} /><span>{tr('团队消息', 'Team messages')}</span></button>}<button onClick={onRoute} title={tr('查看执行记录', 'View execution history')}><List size={15} /><span>{tr('执行记录', 'Activity')}</span></button><button onClick={onBack}><ArrowLeft size={15} /><span>{tr('返回对话', 'Back to chat')}</span></button></div></header>
    {(settingsError || modelError || syncError) && <p className="ao-warning" role="status">{settingsError || modelError || syncError}</p>}
    <div className="ao-view">
      <div className="ao-overview"><span>{tr('{count} 位执行中', '{count} working', { count: model.working })}</span><span>{tr('{count} 位等待中', '{count} waiting', { count: model.waiting })}</span></div>
      <div className={`ao-scene ${ready ? 'ready' : ''}`} ref={stage} aria-busy={!ready && !sceneError} />
      {!ready && !sceneError && <div className="ao-loading" role="status">{tr('正在布置办公室…', 'Preparing the office…')}</div>}
      {sceneError && <div className="ao-loading" role="status"><p>{sceneError}</p><button onClick={() => setRetry(v => v + 1)}>{tr('重试场景', 'Retry scene')}</button></div>}
      <div className="ao-camera" aria-label={tr('场景控制', 'Scene controls')}><button aria-label={tr('缩小', 'Zoom out')} disabled={!ready || zoom <= 65} onClick={() => world.current?.zoom(1 / 1.15)}><Minus size={16} /></button><output>{zoom}%</output><button aria-label={tr('放大', 'Zoom in')} disabled={!ready || zoom >= 220} onClick={() => world.current?.zoom(1.15)}><Plus size={16} /></button><i /><button aria-label={tr('回到全景', 'Reset view')} disabled={!ready} onClick={() => world.current?.reset()}><RotateCcw size={16} /></button><button aria-label={pausedAnimation ? tr('播放场景动画', 'Play scene animation') : tr('暂停场景动画', 'Pause scene animation')} aria-pressed={pausedAnimation} onClick={() => setPausedAnimation(!pausedAnimation)} disabled={!ready}>{pausedAnimation ? <Play size={15} /> : <Pause size={15} />}</button></div>
      {pages > 1 && <div className="ao-zones"><button aria-label={tr('上一个工位分区', 'Previous zone')} disabled={page === 0} onClick={() => { setZone(page - 1); setSelected(null); }}><ChevronLeft size={15} /></button><span>{tr('工位分区', 'Zone')} {page + 1} / {pages}</span><button aria-label={tr('下一个工位分区', 'Next zone')} disabled={page === pages - 1} onClick={() => { setZone(page + 1); setSelected(null); }}><ChevronRight size={15} /></button></div>}
      {agent && <aside className="ao-detail" aria-label={tr('{name} 角色详情', '{name} details', { name: agent.name })}>
        <div className="ao-detail-heading"><Avatar agent={agent} /><div><h3>{agent.name}</h3><small>{agent.roleName}</small></div><button aria-label={tr('关闭角色详情', 'Close agent details')} onClick={() => setSelected(null)}><X size={17} /></button></div>
        <p className="ao-description">{agent.description}</p>
        {onChat && <button className="ao-link" onClick={() => onChat(agent.id === 'lead' ? 'main' : agent.profileId || agent.role)}><MessagesSquare size={15} />{tr('聊一聊', 'Chat')}</button>}
        <p className="ao-status"><i className={`ao-dot ${agent.state}`} /><strong>{agent.statusText}</strong></p>
        <p className="ao-detail-text">{agent.detail}</p>
        {agent.task && <p className="ao-assignment">{agent.task}</p>}
        <dl><div><dt>{tr('模型', 'Model')}</dt><dd>{agent.configuration?.model || '—'}</dd></div><div><dt>{tr('耗时', 'Duration')}</dt><dd>{formatElapsed}</dd></div><div><dt>{tr('请求', 'Requests')}</dt><dd>{agent.budget?.requests ?? '—'}</dd></div><div><dt>Tokens</dt><dd>{tokens ?? '—'}{agent.budget?.unknown ? ` + ${tr('部分未知', 'partly unknown')}` : ''}</dd></div><div><dt>{tr('费用', 'Cost')}</dt><dd>{tr('暂无可靠计价', 'No verified price')}</dd></div>{agent.dependsOn?.length > 0 && <div><dt>{tr('依赖', 'Dependencies')}</dt><dd>{agent.dependsOn.map(id => model.roster.find(a => a.agentId === id)?.name || id).join(', ')}</dd></div>}</dl>
        {agent.summary && agent.summary !== agent.detail && <p className="ao-detail-text">{agent.summary}</p>}
        {canControl && <form onSubmit={e => { e.preventDefault(); if (guidance.trim()) void action('steer'); }}><textarea aria-label={tr('追加要求', 'Additional instructions')} maxLength={4000} rows={2} value={guidance} onChange={e => setGuidance(e.target.value)} placeholder={tr('给这个 Agent 追加要求…', 'Additional instructions for this agent…')} /><div className="ao-actions"><button type="submit" disabled={pending || !guidance.trim()}>{tr('追加要求', 'Send guidance')}</button>{agent.id === 'lead' && <button type="button" disabled={pending} onClick={() => void action(model.paused ? 'resume' : 'pause')}>{model.paused ? <Play size={13} /> : <Pause size={13} />}{model.paused ? tr('继续任务', 'Resume task') : tr('暂停任务', 'Pause task')}</button>}<button type="button" disabled={pending} onClick={() => void action('stop')}><Square size={12} />{tr('停止', 'Stop')}</button></div></form>}
        {notice && <p className="ao-notice" role="status">{notice}</p>}
        {(agent.state === 'attention' || agent.state === 'error') && <button className="ao-link" onClick={onBack}>{tr('返回对话处理', 'Handle in chat')}<ArrowLeft size={14} /></button>}
        <button className="ao-link" disabled={!ready} onClick={() => world.current?.focus(agent.id)}><Focus size={15} />{tr('靠近这个工位', 'Focus workstation')}</button>
      </aside>}
    </div>
    <nav className="ao-roster" aria-label={tr('办公室角色', 'Office agents')}>{model.roster.map(item => <button data-agent-id={item.agentId || item.id} data-state={item.state} key={item.id} aria-pressed={selected === item.id} title={`${item.name} · ${item.statusText}`} onClick={() => selectAgent(item)}><Avatar agent={item} /><span><b>{item.name}</b><small>{item.statusText}</small></span><i className={`ao-dot ${item.state}`} /></button>)}</nav>
  </section>;
}

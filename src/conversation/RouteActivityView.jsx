import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowUp, ArrowRight, Check, ChevronDown, ChevronRight, Circle, Clock3, FileText, History, LoaderCircle, Pause } from 'lucide-react';
import { ApprovalCard, DiffReviewPanel } from '../agent-components';
import { collectTaskRouteRuns } from '../p0-model.js';
import { useI18n } from '../i18n';
import { useWorkbenchContext } from '../workbench/use-workbench.js';
import { activeRouteRecords, activityActor, activityElapsed, activityStatus, describeRouteRecord, formatActivityElapsed, routeActivityRecords, routeRunLabel, routeRunStatus } from './route-activity-model.js';
import '../workbench/side-chat.css';
import './route-activity.css';
import { ProfessionalAgentPanel } from './ProfessionalAgentPanel.jsx';
import { ACTIVITY_AGENT_ROLES, activityRecordStatus, routeAgentActivity } from './route-activity-model.js';

const LIVE_STATES = ['running', 'starting', 'waiting'];
const attention = (record) => ['failed', 'retry', 'blocked', 'partial', 'interrupted'].includes(record.status) || record.kind === 'warning';
const tone = (status) => status === 'running' || status === 'starting' ? 'live'
  : status === 'waiting' || status === 'paused' ? 'paused'
    : status === 'failed' ? 'error'
      : ['retry', 'blocked', 'partial', 'interrupted', 'needs_input'].includes(status) ? 'warn'
        : status === 'completed' || status === 'recovered' ? 'done' : 'idle';

function RecordIcon({ record, size = 12 }) {
  if (record.status === 'running') return <LoaderCircle size={size} className="spin" />;
  if (record.status === 'waiting' || record.status === 'paused') return <Pause size={size} />;
  if (attention(record)) return <AlertTriangle size={size} />;
  if (record.status === 'completed' || record.status === 'recovered') return <Check size={size} />;
  return <Clock3 size={size} />;
}

function timeLabel(value, language) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
}

function finiteTimes(values) {
  return values.map((value) => Date.parse(value)).filter(Number.isFinite);
}

function AgentActivitySummary({ run }) {
  const { tr } = useI18n();
  const stats = routeAgentActivity(run);
  const labels = { main: tr('主 Agent', 'Main'), explore: tr('探索', 'Explore'), review: tr('审查', 'Review'), verify: tr('验证', 'Verify'), curator: tr('知识整理', 'Curator'), builder: 'Builder' };
  return <section className="ra-agents" aria-label={tr('本轮 Agent 使用情况', 'Agent activity in this run')}>
    <div className="ra-agent-counts" title={tr('按实际启动次数统计，包含继续执行；模型请求轮数和心跳不重复计数。', 'Counts actual starts, including continuations; model rounds and heartbeats do not count.')}>
      {ACTIVITY_AGENT_ROLES.map((role) => {
        const value = stats.roles[role]?.activations;
        return <span className={`ra-agent-count ${stats.roles[role]?.active ? 'active' : ''} ${value ? '' : 'empty'}`} data-agent-role={role} key={role}>
          <span>{labels[role]}</span><b>{value == null ? '—' : `${stats.legacy ? '≥' : ''}${value}`}</b><small>{tr('次', 'starts')}</small>
        </span>;
      })}
    </div>
    <div className="ra-builder-capacity" data-testid="builder-capacity">
      <span>{tr('Builder 并发', 'Builder concurrency')} <b>{stats.legacy ? '—' : stats.builder.running} / {stats.builder.limit ?? '—'}</b></span>
      {stats.builder.queued > 0 && <span>{tr('排队 {count}', '{count} queued', { count: stats.builder.queued })}</span>}
      {stats.builder.peak != null && <span>{tr('本轮峰值 {count}', 'Run peak {count}', { count: stats.builder.peak })}</span>}
    </div>
    {stats.legacy && <small className="ra-agent-legacy">{tr('旧记录未保存完整次数与并发上限，已有次数仅为已知下限。', 'Older records lack complete counters and limits; shown counts are lower bounds.')}</small>}
  </section>;
}

function RecordDetails({ record, now, canOpenFile, onOpenFile, openError, id }) {
  const { tr, language } = useI18n();
  const detail = record.detail && ![record.error, record.path, record.command].includes(record.detail) ? record.detail : null;
  const rows = [
    [tr('工具', 'Tool'), record.tool, 'code'],
    [tr('Agent', 'Agent'), record.agentId, 'code'],
    [tr('位置', 'Location'), record.path, 'code'],
    [tr('命令', 'Command'), record.command, 'block'],
    [tr('错误', 'Error'), record.error, 'error'],
    [tr('记录摘要', 'Recorded summary'), detail],
    [tr('退出码', 'Exit code'), record.exitCode, 'code'],
    [tr('开始时间', 'Started'), record.startedAt && timeLabel(record.startedAt, language), 'code'],
    [tr('结束时间', 'Finished'), record.completedAt && timeLabel(record.completedAt, language), 'code'],
    [tr('最近活动信号', 'Last activity signal'), record.lastActivityAt && timeLabel(record.lastActivityAt, language), 'code'],
    [tr('耗时', 'Elapsed'), formatActivityElapsed(activityElapsed(record, now)), 'code'],
  ].filter(([, value]) => value != null && value !== '');
  return <div className="ra-detail" id={id}>
    {record.acceptance && <p className="ra-detail-note">{tr('验收', 'Acceptance')}: {activityRecordStatus(record, language)}{record.acceptance.reason ? ` · ${record.acceptance.reason}` : ''}</p>}
    <dl className="ra-record-details">
      {rows.map(([label, value, kind]) => <div key={label} className={kind ? `is-${kind}` : undefined}><dt>{label}</dt><dd>{String(value)}</dd></div>)}
    </dl>
    {record.kind === 'thinking' && <p className="ra-detail-note">{tr('活动时间来自模型响应事件；不能据此推断思考内容或已完成的工作。', 'Activity times come from response events, not inferred reasoning or completed work.')}</p>}
    {record.path && canOpenFile && <button type="button" className="ra-open-file" onClick={() => onOpenFile(record.path)}><FileText size={13} />{tr('在侧栏打开文件', 'Open file in sidebar')}<ArrowRight size={13} /></button>}
    {openError && <p role="alert" className="ra-open-error">{openError}</p>}
  </div>;
}

export function RouteActivityView({ task, isRunning, approval, approvalResponding, onRespondApproval, onRevert, onSaveChanges, onNotice, onDialogChange }) {
  const { tr, language } = useI18n();
  const workbench = useWorkbenchContext();
  const runs = useMemo(() => collectTaskRouteRuns(task), [task]);
  // null explicitly means follow the newest run. Picking history pins that run
  // even when another round starts; heartbeats never override user selection.
  const [pinnedRunId, setPinnedRunId] = useState(null);
  const selectedRun = runs.find((run) => run.id === pinnedRunId) || runs.at(-1);
  const selectedIndex = runs.findIndex((run) => run.id === selectedRun?.id);
  const isLatest = selectedRun?.id === runs.at(-1)?.id;
  const records = useMemo(() => routeActivityRecords(selectedRun), [selectedRun]);
  const active = useMemo(() => activeRouteRecords(records).reverse(), [records]);
  const state = routeRunStatus(selectedRun);
  const [expandedId, setExpandedId] = useState(null);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [review, setReview] = useState(null);
  const [reverting, setReverting] = useState(false);
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(40);
  const [follow, setFollow] = useState(true);
  const [now, setNow] = useState(Date.now);
  const [openError, setOpenError] = useState('');
  const listRef = useRef(null);
  const runMenuRef = useRef(null);
  const runButtonRef = useRef(null);
  const viewportAnchor = useRef(null);
  const previousView = useRef('');
  const dialogOpen = Boolean(review);
  const reviewRun = runs.find((run) => run.id === review?.runId);
  const reviewChanges = (reviewRun?.changes || []).filter((change) => !review?.path || change.path === review.path);
  const history = records.filter((record) => !['running', 'waiting', 'paused'].includes(record.status));
  const filtered = history.filter((record) => filter === 'tools' ? record.kind === 'tool' : filter === 'attention' ? attention(record) : true);
  const visible = filtered.slice(-limit).reverse();
  const visibleRecordKey = visible.map((record) => record.id).join('\0');
  const plan = selectedRun?.plan || selectedRun?.witness?.plan;
  const planSteps = plan?.steps || [];
  const changes = selectedRun?.changes || [];
  const live = isLatest && LIVE_STATES.includes(state);

  const overview = useMemo(() => {
    const starts = finiteTimes([selectedRun?.createdAt, ...records.map((record) => record.startedAt)]);
    const ends = finiteTimes([selectedRun?.completedAt, ...records.map((record) => record.completedAt || record.lastActivityAt || record.startedAt)]);
    return {
      start: starts.length ? Math.min(...starts) : null,
      end: ends.length ? Math.max(...ends) : null,
      tools: records.filter((record) => record.kind === 'tool' || record.tool).length,
      attention: records.filter(attention).length,
      additions: changes.reduce((sum, change) => sum + (Number(change.additions) || 0), 0),
      deletions: changes.reduce((sum, change) => sum + (Number(change.deletions) || 0), 0),
    };
  }, [records, selectedRun, changes]);
  const duration = overview.start == null ? null : Math.max(0, (live ? now : overview.end ?? now) - overview.start);

  useEffect(() => { setPinnedRunId(null); setExpandedId(null); setReview(null); setRunMenuOpen(false); }, [task.id]);
  useEffect(() => { setLimit(40); setFollow(true); setExpandedId(null); setReview(null); }, [selectedRun?.id]);
  useEffect(() => {
    onDialogChange?.(dialogOpen);
    return () => { if (dialogOpen) onDialogChange?.(false); };
  }, [dialogOpen, onDialogChange]);
  useEffect(() => {
    if ((!active.length && !live) || state === 'paused') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active.length, live, state]);
  useEffect(() => {
    if (!runMenuOpen) return;
    const close = (event) => { if (!runMenuRef.current?.contains(event.target)) setRunMenuOpen(false); };
    const escape = (event) => { if (event.key === 'Escape') { setRunMenuOpen(false); runButtonRef.current?.focus(); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [runMenuOpen]);

  const rememberViewport = () => {
    const list = listRef.current;
    if (!list) return;
    const top = list.getBoundingClientRect().top;
    const row = [...list.querySelectorAll('.ra-event')].find((item) => item.getBoundingClientRect().bottom > top + 1);
    viewportAnchor.current = row ? { id: row.dataset.recordId, offset: row.getBoundingClientRect().top - top } : null;
  };
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const view = `${selectedRun?.id || ''}\0${filter}`;
    if (follow || previousView.current !== view) list.scrollTop = 0;
    else if (viewportAnchor.current) {
      // Keep the row being read stationary when newer records are prepended.
      // This also works when native scroll anchoring has already compensated.
      const row = [...list.querySelectorAll('.ra-event')].find((item) => item.dataset.recordId === viewportAnchor.current.id);
      if (row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - viewportAnchor.current.offset;
    }
    previousView.current = view;
    rememberViewport();
  }, [visibleRecordKey, selectedRun?.id, follow, filter, limit]);

  const toggleRecord = (record) => { setOpenError(''); setExpandedId((current) => current === record.id ? null : record.id); };
  const chooseRun = (id) => { setPinnedRunId(id === runs.at(-1)?.id ? null : id); setRunMenuOpen(false); setExpandedId(null); };
  const showFile = async (path) => {
    try {
      if (!await workbench?.openHref?.(path, { workspacePath: task.workspacePath })) throw new Error(tr('此位置无法在侧栏打开。', 'This location cannot be opened in the sidebar.'));
      setExpandedId(null);
    } catch (error) { setOpenError(error.message); }
  };
  // Escape inside an expanded record collapses it and returns focus to its toggle.
  const collapseOnEscape = (record) => (event) => {
    if (event.key !== 'Escape' || expandedId !== record.id) return;
    event.stopPropagation();
    setExpandedId(null);
    event.currentTarget.querySelector('.ra-detail-button')?.focus();
  };
  const detailToggle = (record) => {
    const expanded = expandedId === record.id;
    return <button type="button" className="ra-detail-button" aria-expanded={expanded} aria-controls={`ra-detail-${record.id}`}
      aria-label={tr('查看详情：{title}', 'View details: {title}', { title: describeRouteRecord(record, language).title })} onClick={() => toggleRecord(record)}>
      <ChevronRight size={15} />
    </button>;
  };
  const details = (record) => expandedId === record.id && <RecordDetails id={`ra-detail-${record.id}`} record={record} now={now} canOpenFile={Boolean(workbench)} onOpenFile={showFile} openError={openError} />;

  if (!runs.length && !isRunning) return <div className="route-empty"><span>{tr('执行记录', 'Activity')}</span><h2>{tr('还没有执行记录', 'No activity yet')}</h2><p>{tr('任务开始后，这里会显示正在进行的动作和实际结果。', 'Live actions and their results will appear here when a task starts.')}</p></div>;

  const planDone = planSteps.filter((step) => step.status === 'completed').length;

  return <>
    <div className="route-view route-activity">
      <header className="ra-heading">
        <div className="ra-heading-copy">
          <h2>{selectedRun?.summary || task.title}</h2>
        </div>
        <div className="ra-toolbar" ref={runMenuRef}>
          <button type="button" ref={runButtonRef} className="ra-run-trigger" aria-haspopup="menu" aria-expanded={runMenuOpen} onClick={() => setRunMenuOpen((open) => !open)} aria-label={tr('选择任务轮次', 'Choose run')}>
            <History size={14} />{tr('第 {count} 轮', 'Run {count}', { count: selectedIndex + 1 })}<ChevronDown size={13} />
          </button>
          {runMenuOpen && <div className="ra-run-menu" role="menu" aria-label={tr('任务轮次', 'Task runs')}>
            <div className="ra-run-list">{[...runs].reverse().map((run, index) => {
              const current = run.id === selectedRun?.id;
              return <button key={run.id} type="button" role="menuitemradio" aria-checked={current} onClick={() => chooseRun(run.id)}>
                <span className={`ra-dot tone-${tone(routeRunStatus(run))}`} aria-hidden="true" />
                <span><b>{tr('第 {count} 轮', 'Run {count}', { count: runs.length - index })}</b><strong>{run.summary}</strong><small>{routeRunLabel(run, language)}</small></span>
                {current && <Check size={14} />}
              </button>;
            })}</div>
          </div>}
        </div>
      </header>

      <section className="ra-overview" aria-label={tr('本轮概况', 'Run overview')}>
        <div className="ra-stat ra-stat-state"><span>{tr('状态', 'Status')}</span><strong className={`ra-state ${state}`}><i className={`ra-dot tone-${tone(state)}`} aria-hidden="true" />{routeRunLabel(selectedRun, language)}</strong></div>
        <div className="ra-stat"><span>{tr('用时', 'Duration')}</span><strong>{duration == null ? '—' : formatActivityElapsed(duration)}</strong></div>
        <div className="ra-stat"><span>{tr('工具调用', 'Tool calls')}</span><strong>{overview.tools}</strong></div>
        <div className={`ra-stat ${overview.attention ? 'is-attention' : ''}`}><span>{tr('需关注', 'Attention')}</span><strong>{overview.attention}</strong></div>
        <div className="ra-stat"><span>{tr('文件修改', 'Files changed')}</span><strong>{changes.length}{changes.length > 0 && <small><em className="add">+{overview.additions}</em><em className="del">−{overview.deletions}</em></small>}</strong></div>
      </section>

      {!selectedRun?.subagents?.length && <AgentActivitySummary run={selectedRun} />}
      <ProfessionalAgentPanel key={selectedRun?.id} run={selectedRun} taskId={task.id} active={isLatest && isRunning} />
      {!isLatest && <div className="ra-history-notice"><span>{tr('正在查看历史轮次，当前任务不受影响。', 'Viewing history. The current task is unaffected.')}</span><button type="button" onClick={() => chooseRun(runs.at(-1).id)}>{tr('回到最新一轮', 'Back to latest')}<ArrowRight size={13} /></button></div>}
      {isLatest && approval && <ApprovalCard approval={approval} responding={approvalResponding} onRespond={onRespondApproval} />}

      {(planSteps.length > 0 || changes.length > 0) && <div className={`ra-board ${planSteps.length && changes.length ? 'two' : ''}`}>
        {planSteps.length > 0 && <section className="ra-card" aria-label={tr('行动计划', 'Action plan')}>
          <header className="ra-card-heading"><h3>{tr('计划', 'Plan')}</h3><span>{planDone} / {planSteps.length}</span></header>
          <div className="ra-progress" role="progressbar" aria-valuemin={0} aria-valuemax={planSteps.length} aria-valuenow={planDone}><span style={{ width: `${(planDone / planSteps.length) * 100}%` }} /></div>
          <ol className="ra-plan">{planSteps.map((step, index) => {
            const status = step.status === 'in_progress' ? 'running' : step.status;
            return <li key={step.id || index} className={`tone-${tone(status)}`}>
              <span className="ra-plan-mark">{step.status === 'pending' ? <Circle size={12} /> : <RecordIcon record={{ status }} />}</span>
              <div><strong>{step.title}</strong>{step.detail && <p>{step.detail}</p>}<small>{step.status === 'pending' ? tr('待进行', 'Pending') : activityStatus(status, language)}</small></div>
            </li>;
          })}</ol>
        </section>}
        {changes.length > 0 && <section className="ra-card" aria-label={tr('本轮修改', 'Changes in this run')}>
          <header className="ra-card-heading"><h3>{tr('修改文件', 'Changed files')}</h3><span>{changes.length}</span></header>
          <div className="ra-change-list">{changes.map((change) => <button type="button" key={change.path} title={change.path} onClick={() => setReview({ runId: selectedRun.id, path: change.path })}>
            <FileText size={13} /><span>{change.path}</span><small><em className="add">+{change.additions || 0}</em><em className="del">−{change.deletions || 0}</em></small><ChevronRight size={14} />
          </button>)}</div>
        </section>}
      </div>}

      {active.length > 0 && <section className="ra-current" aria-label={tr('正在进行的动作', 'Current actions')}>
        <div className="ra-section-heading"><h3>{state === 'paused' ? tr('暂停中的动作', 'Paused actions') : tr('正在进行', 'In progress')}</h3><span>{tr('{count} 项', '{count} actions', { count: active.length })}</span></div>
        <div className="ra-current-list">{active.map((record) => {
          const description = describeRouteRecord(record, language);
          const activityAt = record.lastActivityAt || record.startedAt;
          return <div className={`ra-current-row ${record.status} ${expandedId === record.id ? 'expanded' : ''}`} key={record.id} data-record-id={record.id} onKeyDown={collapseOnEscape(record)}>
            <span className="ra-record-icon"><RecordIcon record={record} size={13} /></span>
            <div className="ra-record-copy">
              <div className="ra-actor">{activityActor(record, language)}{record.agentId && <span title={record.agentId}>{record.agentId}</span>}</div>
              <strong>{description.title}</strong>
              {description.detail && <p className={description.detail === record.path || description.detail === record.command ? 'mono' : undefined}>{description.detail}</p>}
              <small>{activityRecordStatus(record, language)} · {activityAt ? tr('最近信号 {time}', 'Last signal {time}', { time: timeLabel(activityAt, language) }) : tr('等待活动信号', 'Waiting for activity')}</small>
            </div>
            <time className="ra-duration">{formatActivityElapsed(activityElapsed(record, now))}</time>{detailToggle(record)}
            {details(record)}
          </div>;
        })}</div>
      </section>}
      {isLatest && !active.length && LIVE_STATES.concat('paused').includes(state) && <div className="ra-awaiting"><Clock3 size={14} /><span>{state === 'waiting' ? tr('等待用户确认', 'Awaiting approval') : state === 'paused' ? tr('任务已暂停', 'Task paused') : tr('等待下一个可观察动作', 'Waiting for the next observable action')}</span></div>}

      <section className="ra-history" aria-label={tr('历史行动', 'Action history')}>
        <div className="ra-history-toolbar">
          <div className="ra-section-heading"><h3>{tr('时间线', 'Timeline')}</h3><span>{tr('{count} 条', '{count} events', { count: history.length })}</span></div>
          <div className="ra-history-controls">
            <div className="ra-filters" role="group" aria-label={tr('筛选记录', 'Filter activity')}>
              {[['all', tr('全部', 'All')], ['tools', tr('工具', 'Tools')], ['attention', tr('需关注', 'Attention')]].map(([value, label]) => <button type="button" aria-pressed={filter === value} key={value} onClick={() => { setFilter(value); setLimit(40); setExpandedId(null); }}>{label}</button>)}
            </div>
            <button type="button" className="ra-follow" aria-pressed={follow} onClick={() => setFollow((value) => !value)}><ArrowUp size={13} />{follow ? tr('跟随最新', 'Following latest') : tr('回到最新记录', 'Jump to latest')}</button>
          </div>
        </div>
        <div className="ra-timeline" ref={listRef} tabIndex={0} aria-label={tr('执行记录时间线', 'Activity timeline')} onScroll={() => {
          const element = listRef.current;
          if (element && element.scrollTop > 40) setFollow(false);
          rememberViewport();
        }}>
          {visible.map((record) => {
            const description = describeRouteRecord(record, language);
            const target = record.error && (record.command || record.path);
            return <div className={`ra-event ${record.status} tone-${tone(record.status)} ${expandedId === record.id ? 'expanded' : ''}`} key={record.id} data-record-id={record.id} onKeyDown={collapseOnEscape(record)}>
              <time className="ra-event-time">{timeLabel(record.startedAt, language)}</time>
              <span className="ra-record-icon"><RecordIcon record={record} size={11} /></span>
              <div className="ra-record-copy">
                <div className="ra-event-title"><strong>{description.title}</strong><span className="ra-event-actor">{activityActor(record, language)}</span>{record.tool && <code className="ra-tool">{record.tool}</code>}</div>
                {target && <p className="ra-event-target mono">{target}</p>}
                {description.detail && <p className={record.error ? 'ra-event-error' : description.detail === record.path || description.detail === record.command ? 'mono' : undefined}>{description.detail}</p>}
              </div>
              <div className="ra-event-meta"><span>{activityRecordStatus(record, language)}</span><time>{formatActivityElapsed(activityElapsed(record, now))}</time></div>{detailToggle(record)}
              {details(record)}
            </div>;
          })}
          {filtered.length > visible.length && <button className="ra-load-older" type="button" onClick={() => { rememberViewport(); setFollow(false); setLimit((value) => value + 40); }}>{tr('显示更早的记录（剩余 {count} 条）', 'Show earlier records ({count} remaining)', { count: filtered.length - visible.length })}</button>}
          {!visible.length && <p className="ra-empty-list">{filter === 'attention' ? tr('暂无需关注的记录', 'No attention items') : tr('暂无已结束的动作', 'No finished actions yet')}</p>}
        </div>
        {selectedRun?.witness?.omittedRecords > 0 && <footer className="ra-retention"><span>{tr('Witness 仅保留最近 {count} 条；更早的工具记录若已保存仍可查看。', 'Witness retains its latest {count} records; older saved tool entries remain available.', { count: selectedRun.witness.records.length })}</span></footer>}
      </section>
    </div>

    {reviewChanges.length > 0 && <DiffReviewPanel changes={reviewChanges} reverting={reverting} workspacePath={task.workspacePath} initialPath={review?.path || ''} onClose={() => setReview(null)} onSave={(result) => onSaveChanges?.(reviewRun.messageId, result)} onNotice={onNotice} onRevert={async (paths) => { setReverting(true); try { await onRevert?.(reviewRun.messageId, paths); } finally { setReverting(false); } }} />}
  </>;
}

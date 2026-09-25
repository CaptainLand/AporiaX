import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowUp, ArrowRight, Check, ChevronDown, ChevronRight, Clock3, FileText, History, ListChecks, LoaderCircle, Pause } from 'lucide-react';
import { ApprovalCard, DiffReviewPanel } from '../agent-components';
import { collectTaskRouteRuns } from '../p0-model.js';
import { useI18n } from '../i18n';
import { useWorkbenchContext } from '../workbench/use-workbench.js';
import { SideChatDialog } from '../workbench/SideChatDialog.jsx';
import { activeRouteRecords, activityActor, activityElapsed, activityStatus, describeRouteRecord, formatActivityElapsed, routeActivityRecords, routeRunLabel, routeRunStatus } from './route-activity-model.js';
import '../workbench/side-chat.css';
import './route-activity.css';
import { ACTIVITY_AGENT_ROLES, activityRecordStatus, routeAgentActivity } from './route-activity-model.js';

function AgentActivitySummary({ run }) {
  const { tr } = useI18n();
  const stats = routeAgentActivity(run);
  const labels = { main: tr('主 Agent', 'Main'), explore: tr('探索', 'Explore'), review: tr('审查', 'Review'), verify: tr('验证', 'Verify'), curator: tr('知识整理', 'Curator'), builder: 'Builder' };
  return <section className="ra-agents" aria-label={tr('本轮 Agent 使用情况', 'Agent activity in this run')}>
    <div className="ra-agent-counts" title={tr('按实际启动次数统计，包含继续执行；模型请求轮数和心跳不重复计数。', 'Counts actual starts, including continuations; model rounds and heartbeats do not count.')}>
      {ACTIVITY_AGENT_ROLES.map((role) => <span className={`ra-agent-count ${stats.roles[role]?.active ? 'active' : ''}`} data-agent-role={role} key={role}><span>{labels[role]}</span><b>{stats.roles[role]?.activations == null ? '—' : `${stats.legacy ? '≥' : ''}${stats.roles[role].activations}`}</b><small>{tr('次', 'starts')}</small></span>)}
    </div>
    <div className="ra-builder-capacity" data-testid="builder-capacity"><span>{tr('Builder 并发', 'Builder concurrency')} <b>{stats.legacy ? '—' : stats.builder.running} / {stats.builder.limit ?? '—'}</b></span>{stats.builder.queued > 0 && <span>{tr('排队 {count}', '{count} queued', { count: stats.builder.queued })}</span>}{stats.builder.peak != null && <span>{tr('本轮峰值 {count}', 'Run peak {count}', { count: stats.builder.peak })}</span>}</div>
    {stats.legacy && <small className="ra-agent-legacy">{tr('旧记录未保存完整次数与并发上限，已有次数仅为已知下限。', 'Older records lack complete counters and limits; shown counts are lower bounds.')}</small>}
  </section>;
}

const attention = (record) => ['failed', 'retry', 'blocked', 'partial', 'interrupted'].includes(record.status) || record.kind === 'warning';
function RecordIcon({ record }) {
  if (record.status === 'running') return <LoaderCircle size={14} className="spin" />;
  if (record.status === 'waiting' || record.status === 'paused') return <Pause size={14} />;
  if (attention(record)) return <AlertTriangle size={14} />;
  if (record.status === 'completed' || record.status === 'recovered') return <Check size={14} />;
  return <Clock3 size={14} />;
}
function timeLabel(value, language) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
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
  const [dialog, setDialog] = useState(null);
  const [review, setReview] = useState(null);
  const [reverting, setReverting] = useState(false);
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(40);
  const [follow, setFollow] = useState(true);
  const [now, setNow] = useState(Date.now);
  const [openError, setOpenError] = useState('');
  const listRef = useRef(null);
  const viewportAnchor = useRef(null);
  const previousView = useRef('');
  const dialogOpen = Boolean(dialog || review);
  const selectedRecord = dialog?.kind === 'record' ? records.find((record) => record.id === dialog.id) || dialog.record : null;
  const reviewRun = runs.find((run) => run.id === review?.runId);
  const reviewChanges = (reviewRun?.changes || []).filter((change) => !review?.path || change.path === review.path);
  const history = records.filter((record) => !['running', 'waiting', 'paused'].includes(record.status));
  const filtered = history.filter((record) => filter === 'tools' ? record.kind === 'tool' : filter === 'attention' ? attention(record) : true);
  const visible = filtered.slice(-limit).reverse();
  const visibleRecordKey = visible.map((record) => record.id).join('\0');
  const plan = selectedRun?.plan || selectedRun?.witness?.plan;

  useEffect(() => { setPinnedRunId(null); setDialog(null); setReview(null); }, [task.id]);
  useEffect(() => { setLimit(40); setFollow(true); setDialog(null); setReview(null); }, [selectedRun?.id]);
  useEffect(() => {
    onDialogChange?.(dialogOpen);
    return () => { if (dialogOpen) onDialogChange?.(false); };
  }, [dialogOpen, onDialogChange]);
  useEffect(() => {
    if (!active.length || state === 'paused') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active.length, state]);
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

  const openRecord = (record) => { setOpenError(''); setDialog({ kind: 'record', id: record.id, record }); };
  const chooseRun = (id) => { setPinnedRunId(id === runs.at(-1)?.id ? null : id); setDialog(null); };
  const detailButton = (record) => <button type="button" className="ra-detail-button" aria-label={tr('查看详情：{title}', 'View details: {title}', { title: describeRouteRecord(record, language).title })} onClick={() => openRecord(record)}><ChevronRight size={16} /></button>;
  const showFile = async (path) => {
    try {
      if (!await workbench?.openHref?.(path, { workspacePath: task.workspacePath })) throw new Error(tr('此位置无法在侧栏打开。', 'This location cannot be opened in the sidebar.'));
      setDialog(null);
    } catch (error) { setOpenError(error.message); }
  };

  if (!runs.length && !isRunning) return <div className="route-empty"><span>{tr('执行记录', 'Activity')}</span><h2>{tr('还没有执行记录', 'No activity yet')}</h2><p>{tr('任务开始后，这里会显示正在进行的动作和实际结果。', 'Live actions and their results will appear here when a task starts.')}</p></div>;

  return <>
    <div className="route-view route-activity">
      <header className="ra-heading">
        <div className="ra-heading-copy"><span className="ra-eyebrow">{tr('执行记录', 'Activity')}</span><h2>{selectedRun?.summary || task.title}</h2></div>
        <div className="ra-toolbar">
          <span className={`ra-state ${state}`}>{routeRunLabel(selectedRun, language)}</span>
          <button type="button" onClick={() => setDialog({ kind: 'runs' })} aria-label={tr('选择任务轮次', 'Choose run')}><History size={14} />{tr('第 {count} 轮', 'Run {count}', { count: selectedIndex + 1 })}<ChevronDown size={13} /></button>
          {!!plan?.steps?.length && <button type="button" onClick={() => setDialog({ kind: 'plan' })}><ListChecks size={14} />{tr('计划', 'Plan')}</button>}
          {!!selectedRun?.changes?.length && <button type="button" onClick={() => setDialog({ kind: 'changes' })}><FileText size={14} />{tr('修改 {count}', '{count} changes', { count: selectedRun.changes.length })}</button>}
        </div>
      </header>
      <AgentActivitySummary run={selectedRun} />
      {!isLatest && <div className="ra-history-notice"><span>{tr('正在查看历史轮次，当前任务不受影响。', 'Viewing history. The current task is unaffected.')}</span><button type="button" onClick={() => chooseRun(runs.at(-1).id)}>{tr('回到最新一轮', 'Back to latest')}<ArrowRight size={13} /></button></div>}
      {isLatest && approval && <ApprovalCard approval={approval} responding={approvalResponding} onRespond={onRespondApproval} />}

      {active.length > 0 && <section className="ra-current" aria-label={tr('正在进行的动作', 'Current actions')}>
        <div className="ra-section-heading"><h3>{state === 'paused' ? tr('暂停中的动作', 'Paused actions') : tr('正在进行', 'In progress')}</h3><span>{tr('{count} 项', '{count} actions', { count: active.length })}</span></div>
        {active.map((record) => {
          const description = describeRouteRecord(record, language);
          const activityAt = record.lastActivityAt || record.startedAt;
          return <div className={`ra-current-row ${record.status}`} key={record.id} data-record-id={record.id}>
            <span className="ra-record-icon"><RecordIcon record={record} /></span>
            <div className="ra-record-copy"><div className="ra-actor">{activityActor(record, language)}{record.agentId && <span title={record.agentId}>{record.agentId}</span>}</div><strong>{description.title}</strong>{description.detail && <p>{description.detail}</p>}<small>{activityRecordStatus(record, language)} · {activityAt ? tr('最近信号 {time}', 'Last signal {time}', { time: timeLabel(activityAt, language) }) : tr('等待活动信号', 'Waiting for activity')}</small></div>
            <time className="ra-duration">{formatActivityElapsed(activityElapsed(record, now))}</time>{detailButton(record)}
          </div>;
        })}
      </section>}
      {isLatest && !active.length && ['running', 'starting', 'waiting', 'paused'].includes(state) && <div className="ra-awaiting"><Clock3 size={15} /><span>{state === 'waiting' ? tr('等待用户确认', 'Awaiting approval') : state === 'paused' ? tr('任务已暂停', 'Task paused') : tr('等待下一个可观察动作', 'Waiting for the next observable action')}</span></div>}

      <section className="ra-history" aria-label={tr('历史行动', 'Action history')}>
        <div className="ra-history-toolbar"><div className="ra-filters" aria-label={tr('筛选记录', 'Filter activity')}>
          { [['all', tr('全部', 'All')], ['tools', tr('工具', 'Tools')], ['attention', tr('需关注', 'Attention')]].map(([value, label]) => <button type="button" aria-pressed={filter === value} key={value} onClick={() => { setFilter(value); setLimit(40); }}>{label}</button>)}
        </div><button type="button" className="ra-follow" aria-pressed={follow} onClick={() => setFollow((value) => !value)}><ArrowUp size={13} />{follow ? tr('跟随最新', 'Following latest') : tr('回到最新记录', 'Jump to latest')}</button></div>
        <div className="ra-timeline" ref={listRef} tabIndex={0} aria-label={tr('执行记录时间线', 'Activity timeline')} onScroll={() => {
          const element = listRef.current;
          if (element && element.scrollTop > 40) setFollow(false);
          rememberViewport();
        }}>
          {visible.map((record) => {
            const description = describeRouteRecord(record, language);
            return <div className={`ra-event ${record.status}`} key={record.id} data-record-id={record.id}>
              <time className="ra-event-time">{timeLabel(record.startedAt, language)}</time><span className="ra-record-icon"><RecordIcon record={record} /></span>
              <div className="ra-record-copy"><strong>{description.title}</strong><span className="ra-event-actor">{activityActor(record, language)}</span>{record.error && (record.command || record.path) && <p className="ra-event-target">{record.command || record.path}</p>}{description.detail && <p>{description.detail}</p>}</div>
              <div className="ra-event-meta"><span>{activityRecordStatus(record, language)}</span><time>{formatActivityElapsed(activityElapsed(record, now))}</time></div>{detailButton(record)}
            </div>;
          })}
          {filtered.length > visible.length && <button className="ra-load-older" type="button" onClick={() => { rememberViewport(); setFollow(false); setLimit((value) => value + 40); }}>{tr('显示更早的记录（剩余 {count} 条）', 'Show earlier records ({count} remaining)', { count: filtered.length - visible.length })}</button>}
          {!visible.length && <p className="ra-empty-list">{filter === 'attention' ? tr('暂无需关注的记录', 'No attention items') : tr('暂无已结束的动作', 'No finished actions yet')}</p>}
        </div>
        <footer className="ra-retention">{tr('最新记录在上 · 展示可观察的事件，不代表完成百分比', 'Newest first · Observable events, not a completion percentage')}{selectedRun?.witness?.omittedRecords > 0 && <span>{tr('Witness 仅保留最近 {count} 条；更早的工具记录若已保存仍可查看。', 'Witness retains its latest {count} records; older saved tool entries remain available.', { count: selectedRun.witness.records.length })}</span>}</footer>
      </section>
    </div>

    {dialog && <SideChatDialog className="ra-dialog" title={dialog.kind === 'record' ? describeRouteRecord(selectedRecord, language).title : dialog.kind === 'runs' ? tr('任务轮次', 'Task runs') : dialog.kind === 'plan' ? tr('行动计划', 'Action plan') : tr('本轮修改', 'Changes in this run')} onClose={() => setDialog(null)}
      subtitle={dialog.kind === 'record' ? `${activityActor(selectedRecord, language)} · ${activityRecordStatus(selectedRecord, language)}` : undefined}>
      {dialog.kind === 'runs' && <div className="ra-run-list">{[...runs].reverse().map((run, index) => <button key={run.id} type="button" aria-current={run.id === selectedRun?.id ? 'true' : undefined} onClick={() => chooseRun(run.id)}><span><b>{tr('第 {count} 轮', 'Run {count}', { count: runs.length - index })}</b><strong>{run.summary}</strong><small>{routeRunLabel(run, language)}</small></span>{run.id === selectedRun?.id ? <Check size={16} /> : <ChevronRight size={16} />}</button>)}</div>}
      {dialog.kind === 'record' && selectedRecord && <>
        {selectedRecord.acceptance && <p className="ra-dialog-note">{tr('验收', 'Acceptance')}: {activityRecordStatus(selectedRecord, language)}{selectedRecord.acceptance.reason ? ` · ${selectedRecord.acceptance.reason}` : ''}</p>}
        <dl className="ra-record-details">
          {[[tr('工具', 'Tool'), selectedRecord.tool], [tr('Agent', 'Agent'), selectedRecord.agentId], [tr('位置', 'Location'), selectedRecord.path], [tr('命令', 'Command'), selectedRecord.command], [tr('错误', 'Error'), selectedRecord.error], [tr('记录摘要', 'Recorded summary'), selectedRecord.detail && selectedRecord.detail !== selectedRecord.error && selectedRecord.detail !== selectedRecord.path && selectedRecord.detail !== selectedRecord.command ? selectedRecord.detail : null], [tr('退出码', 'Exit code'), selectedRecord.exitCode], [tr('开始时间', 'Started'), selectedRecord.startedAt], [tr('结束时间', 'Finished'), selectedRecord.completedAt], [tr('最近活动信号', 'Last activity signal'), selectedRecord.lastActivityAt], [tr('耗时', 'Elapsed'), formatActivityElapsed(activityElapsed(selectedRecord, now))]].filter(([, value]) => value != null && value !== '').map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}
        </dl>
        {selectedRecord.kind === 'thinking' && <p className="ra-dialog-note">{tr('活动时间来自模型响应事件；不能据此推断思考内容或已完成的工作。', 'Activity times come from response events, not inferred reasoning or completed work.')}</p>}
        {selectedRecord.path && workbench && <button type="button" className="ra-open-file" onClick={() => showFile(selectedRecord.path)}><FileText size={14} />{tr('在侧栏打开文件', 'Open file in sidebar')}<ArrowRight size={14} /></button>}
        {openError && <p role="alert" className="ra-open-error">{openError}</p>}
      </>}
      {dialog.kind === 'plan' && <ol className="ra-plan">{plan.steps.map((step, index) => <li key={step.id || index}><span><RecordIcon record={{ status: step.status === 'in_progress' ? 'running' : step.status }} /></span><div><strong>{step.title}</strong>{step.detail && <p>{step.detail}</p>}<small>{step.status === 'pending' ? tr('待进行', 'Pending') : activityStatus(step.status === 'in_progress' ? 'running' : step.status, language)}</small></div></li>)}</ol>}
      {dialog.kind === 'changes' && <div className="ra-change-list">{selectedRun.changes.map((change) => <button type="button" key={change.path} onClick={() => { setDialog(null); setReview({ runId: selectedRun.id, path: change.path }); }}><span>{change.path}</span><small>+{change.additions || 0} / −{change.deletions || 0}</small><ChevronRight size={15} /></button>)}</div>}
    </SideChatDialog>}
    {reviewChanges.length > 0 && <DiffReviewPanel changes={reviewChanges} reverting={reverting} workspacePath={task.workspacePath} initialPath={review?.path || ''} onClose={() => setReview(null)} onSave={(result) => onSaveChanges?.(reviewRun.messageId, result)} onNotice={onNotice} onRevert={async (paths) => { setReverting(true); try { await onRevert?.(reviewRun.messageId, paths); } finally { setReverting(false); } }} />}
  </>;
}

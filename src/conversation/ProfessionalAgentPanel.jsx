import React, { useId, useMemo, useState } from 'react';
import { ArrowUpRight, ChevronDown, CornerDownRight } from 'lucide-react';
import { useI18n } from '../i18n';
import { agentDisplayName } from '../../shared/agent-identity.js';
import { modelTokenLine } from '../../shared/model-progress-view.js';
import { AgentAvatar } from '../components/AgentAvatar.jsx';
import { useWorkbenchContext } from '../workbench/use-workbench.js';
import { agentDelivery, agentFollowupRequest } from './agent-delivery-model.js';
import './professional-agents.css';

function ReportSection({ title, items }) {
  return items?.length ? <section className="pa-report-section"><h5>{title}</h5><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></section> : null;
}

function AgentDeliveryCard({ worker, taskId, runId, active, onContinueAgent }) {
  const { tr, language } = useI18n(), workbench = useWorkbenchContext();
  const delivery = useMemo(() => agentDelivery(worker, language), [worker, language]);
  const detailsId = useId(), [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false), [guidance, setGuidance] = useState('');
  const [pending, setPending] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const enabled = Boolean(active && runId && window.desktop?.agentProfiles);
  const report = delivery.report;
  const call = async (kind) => {
    setPending(true); setNotice(''); setError('');
    try {
      if (enabled) {
        await window.desktop.agentProfiles[kind]({ taskId, runId, agentId: worker.agentId, ...(kind === 'steer' ? { task: guidance.trim() } : {}) });
      } else if (kind === 'steer' && onContinueAgent) {
        const accepted = await onContinueAgent(agentFollowupRequest(worker, guidance, language));
        if (accepted === false) throw new Error(tr('新一轮交办未发送，内容已保留。', 'The follow-up was not sent; your draft is retained.'));
      } else throw new Error(tr('本轮已结束，无法操作原成员。请在对话中发起新一轮交办。', 'The original run ended. Start a new follow-up in the conversation.'));
      setNotice(kind === 'stop' ? tr('已请求停止，保留已有结果。', 'Stop requested; existing results are retained.') : enabled ? tr('交办已送达，将在安全边界处理。', 'Follow-up delivered for the next safe boundary.') : tr('已发送新一轮交办，原报告保持不变。', 'A new follow-up was sent; the original report is unchanged.'));
      if (kind === 'steer') { setGuidance(''); setComposing(false); }
    } catch (failure) { setError(failure.message); } finally { setPending(false); }
  };
  const openFinding = async (location) => {
    setError('');
    try {
      if (!workbench?.openFile) throw new Error(tr('请在桌面工作区中查看该问题位置。', 'Open this issue in the desktop workspace.'));
      await workbench.openFile(location.path, location.line);
    } catch (failure) { setError(failure.message); }
  };
  const outputTokens = worker.usage?.completion_tokens ?? worker.usage?.output_tokens;
  return <article className={'pa-row pa-delivery ' + (delivery.running ? 'is-working' : 'is-returned')} aria-label={agentDisplayName(worker, language) + ' · ' + delivery.status}>
    <header className="pa-header">
      <AgentAvatar template={worker.template || worker.role || worker.roleId || 'explore'} />
      <div><h4><strong>{agentDisplayName(worker, language)}</strong><span>· {delivery.status}</span></h4><p className="pa-task">{delivery.task}</p></div>
    </header>
    <div className="pa-delivery-body">
      <section className={'pa-conclusion ' + (report.findings.length ? 'has-findings' : '')}>
        <h5>{delivery.conclusion}</h5>
        {delivery.previewFindings.map((finding, index) => <p className="pa-finding-preview" key={index}>{finding.message}</p>)}
        {report.malformed && <p>{tr('未把无法解析的内容当作通过结论。原文保留在技术详情中。', 'Unparseable content is not treated as a pass. The original is retained in technical details.')}</p>}
      </section>
      <footer className="pa-footer">
        <button className="pa-details-toggle" type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>{expanded ? tr('收起详情', 'Hide details') : tr('查看详情', 'View details')}<ChevronDown size={12} /></button>
        <div>
          <button className="pa-continue" type="button" aria-expanded={composing} onClick={() => setComposing(value => !value)}><CornerDownRight size={13} />{tr('继续交办', 'Follow up')}</button>
          {enabled && delivery.running && <button className="pa-stop" type="button" disabled={pending} onClick={() => void call('stop')}>{tr('停止此 Agent', 'Stop this Agent')}</button>}
        </div>
      </footer>
      <div id={detailsId} className="pa-foldout" data-open={expanded} aria-hidden={!expanded} inert={!expanded}>
      <div className="pa-foldout-inner"><div className="pa-foldout-content">
        <ReportSection title={tr('检查范围', 'Checks and limitations')} items={delivery.scope} />
        <ReportSection title={tr('下一步', 'Next steps')} items={delivery.next} />
      <div className="pa-delivery-links">
        {delivery.location && <button className="pa-text-action" type="button" onClick={() => void openFinding(delivery.location)}>{tr('查看问题位置', 'View issue location')}<ArrowUpRight size={13} /></button>}
        <details className="pa-full-report"><summary>{tr('展开完整报告', 'Full report')}<ChevronDown size={13} /></summary><div>
          <ReportSection title={tr('结论', 'Conclusion')} items={report.summary ? [report.summary] : [delivery.conclusion]} />
          <ReportSection title={tr('发现的问题', 'Findings')} items={report.findings.map(item => item.message)} />
          <ReportSection title={tr('报告中的检查范围', 'Reported checks')} items={report.checks} />
          <ReportSection title={tr('未验证与风险', 'Unverified work and risks')} items={report.risks} />
          <ReportSection title={tr('下一步', 'Next steps')} items={report.next} />
          <ReportSection title={tr('成员报告', 'Member report')} items={report.paragraphs} />
          {report.malformed && <p>{tr('报告格式异常，请在技术详情查看原文。', 'Malformed report; see the original in technical details.')}</p>}
        </div></details>
      </div>
      <details className="pa-technical"><summary>{tr('技术详情', 'Technical details')}<ChevronDown size={12} /></summary><div className="pa-detail"><dl>
        {worker.configuration?.model && <div><dt>{tr('模型', 'Model')}</dt><dd>{worker.configuration.model}{worker.configuration.effort ? ' · ' + worker.configuration.effort : ''}</dd></div>}
        {Number.isFinite(outputTokens) && <div><dt>{tr('输出', 'Output')}</dt><dd>{modelTokenLine({ outputTokens, outputTokensEstimated: false })}</dd></div>}
        {worker.budget?.unknown > 0 && <div><dt>{tr('用量记录', 'Usage records')}</dt><dd>{tr('部分未知', 'Partly unknown')}</dd></div>}
        <div><dt>{tr('来源', 'Source')}</dt><dd>{worker.systemOwned ? tr('系统辅助', 'System helper') : tr('AporiaX 委派', 'Assigned by AporiaX')}</dd></div>
        {worker.acceptance && <div><dt>{tr('报告接收', 'Report review')}</dt><dd>{worker.acceptance.status === 'accepted' ? tr('主任务已接收此报告，不代表运行验证通过。', 'The parent accepted the report, not proof of runtime validation.') : worker.acceptance.status === 'needs_changes' ? tr('主任务要求补充。', 'The parent requested changes.') : tr('等待主任务审阅。', 'Awaiting parent review.')}{worker.acceptance.reason && <p>{worker.acceptance.reason}</p>}</dd></div>}
        {!!worker.scope?.length && <div><dt>{tr('委派范围', 'Assigned scope')}</dt><dd>{worker.scope.join(', ')}</dd></div>}
        {!!worker.configuration?.tools?.length && <div><dt>{tr('可用工具', 'Available tools')}</dt><dd className="pa-tools">{worker.configuration.tools.map(tool => <code key={tool}>{tool}</code>)}</dd></div>}
        {!!worker.observedChecks?.commands?.length && <div><dt>{tr('运行记录', 'Executed commands')}</dt><dd>{worker.observedChecks.commands.map((item, index) => <p key={index}><code>{item.command}</code> · exit {item.exitCode}</p>)}</dd></div>}
        {!!worker.dependsOn?.length && <div><dt>{tr('依赖', 'Dependencies')}</dt><dd>{worker.dependsOn.join(', ')}</dd></div>}
        {!!worker.changedFiles?.length && <div><dt>{tr('修改文件', 'Changed files')}</dt><dd>{worker.changedFiles.map(item => item.path).join(', ')}</dd></div>}
        <div><dt>{tr('原始委派', 'Original assignment')}</dt><dd className="pa-original-task">{worker.task}</dd></div>
      </dl>{report.raw && <details className="pa-raw-report"><summary>{tr('原始报告', 'Original report')}</summary><pre>{report.raw}</pre></details>}</div></details>
      <p className="pa-meta pa-detail-meta">{[delivery.duration, delivery.requests == null ? '' : tr('{count} 次调用', '{count} calls', { count: delivery.requests })].filter(Boolean).join(' · ')}</p>
      </div></div></div>
      {composing && <form className="pa-followup" onSubmit={event => { event.preventDefault(); if (guidance.trim()) void call('steer'); }}>
        {!enabled && <p>{onContinueAgent ? tr('原轮次已结束，将在当前对话发起新一轮交办，不会恢复旧成员的运行状态。', 'The original run ended. This starts a new follow-up in this conversation, not a resumed worker.') : tr('原轮次已结束，请在主对话中发送下一轮交办。', 'The original run ended. Send the follow-up in the main conversation.')}</p>}
        <textarea autoFocus aria-label={tr('追加要求', 'Additional instructions')} rows={2} maxLength={4000} value={guidance} onChange={event => setGuidance(event.target.value)} placeholder={tr('交办下一件事…', 'What should this member do next?')} />
        <div className="pa-actions"><button type="submit" disabled={pending || !guidance.trim() || (!enabled && !onContinueAgent)}>{enabled ? tr('发送交办', 'Send follow-up') : tr('发送新一轮交办', 'Send new follow-up')}</button><button type="button" onClick={() => setComposing(false)}>{tr('取消', 'Cancel')}</button></div>
      </form>}
      {notice && <p className="pa-notice" role="status">{notice}</p>}{error && <p className="pa-error" role="alert">{error}</p>}
    </div>
  </article>;
}

export function ProfessionalAgentPanel({ run, taskId, active, onContinueAgent }) {
  const { tr } = useI18n(), workers = run?.subagents || [];
  if (!workers.length) return null;
  return <section className="professional-agents" aria-label={tr('专业 Agent', 'Professional Agents')}><h3>{tr('成员交付', 'Member deliveries')}<small>{workers.length}</small></h3>
    {workers.map(worker => <AgentDeliveryCard key={worker.agentId} worker={worker} taskId={taskId} runId={run.runId} active={active} onContinueAgent={onContinueAgent} />)}
  </section>;
}

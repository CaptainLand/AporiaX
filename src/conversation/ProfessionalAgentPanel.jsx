import React, { useState } from 'react';
import { useI18n } from '../i18n';
import './professional-agents.css';

export function ProfessionalAgentPanel({ run, taskId, active }) {
  const { tr } = useI18n();
  const [guidance, setGuidance] = useState({}), [pending, setPending] = useState(''), [notice, setNotice] = useState('');
  const workers = run?.subagents || [];
  const enabled = Boolean(active && run?.runId && window.desktop?.agentProfiles);
  const action = async (kind, worker) => {
    setPending(worker.agentId); setNotice('');
    try {
      const result = await window.desktop.agentProfiles[kind]({ taskId, runId: run.runId, agentId: worker.agentId, task: guidance[worker.agentId] });
      setNotice(kind === 'stop' ? tr('已请求停止，保留已有结果。', 'Stop requested; existing results are retained.') : tr('要求已排队，将在安全边界接收。', 'Guidance queued for the next safe boundary.'));
      if (kind === 'steer') setGuidance(value => ({ ...value, [worker.agentId]: '' }));
      return result;
    } catch (error) { setNotice(error.message); } finally { setPending(''); }
  };
  const status = worker => {
    if (worker.status === 'running') return worker.phase === 'waiting_dependencies' ? tr('等待依赖验收', 'Waiting for dependencies') : worker.phase === 'queued' ? tr('排队中', 'Queued') : worker.phase === 'approval' ? tr('等待批准', 'Awaiting approval') : worker.phase === 'tool' ? `${tr('执行工具', 'Tool')} · ${worker.currentTool || ''}` : tr('调用模型', 'Model request');
    return ({ completed: tr('已完成', 'Completed'), failed: tr('失败', 'Failed'), interrupted: tr('已停止', 'Stopped'), blocked: tr('受阻', 'Blocked'), budget_exhausted: tr('预算耗尽', 'Budget exhausted'), partial: tr('部分完成', 'Partial'), needs_input: tr('需要补充', 'Needs input') })[worker.status] || worker.status;
  };
  if (!workers.length) return null;
  return <section className="professional-agents" aria-label={tr('专业 Agent', 'Professional Agents')}>
    <h3>Agents <small>{workers.length}</small></h3>
    {workers.map(worker => <details key={worker.agentId} className="pa-row">
      <summary><strong>{worker.profileName || worker.role}</strong><span className="pa-task">{worker.task}</span><span>{status(worker)}</span></summary>
      <div className="pa-detail">
        <p>{worker.task}</p>
        <dl>
          <div><dt>{tr('模型', 'Model')}</dt><dd>{worker.configuration?.model || '—'}{worker.configuration?.effort && ` · ${worker.configuration.thinking ? worker.configuration.effort : tr('非思考', 'No reasoning')}`}</dd></div>
          <div><dt>{tr('来源', 'Source')}</dt><dd>{worker.systemOwned ? tr('系统辅助', 'System') : tr('主 Agent 委派', 'Main Agent')}</dd></div>
          <div><dt>{tr('请求', 'Requests')}</dt><dd>{worker.budget?.requests ?? '—'}</dd></div>
          <div><dt>Tokens</dt><dd>{worker.budget ? `${worker.budget.tokens}${worker.budget.unknown ? ` + ${tr('部分未知', 'partly unknown')}` : ''}` : worker.usage?.total_tokens ?? '—'}</dd></div>
          <div><dt>{tr('耗时', 'Duration')}</dt><dd>{worker.elapsedMs != null ? `${(worker.elapsedMs / 1000).toFixed(1)}s` : tr('执行中 / 暂无记录', 'In progress / unrecorded')}</dd></div>
          <div><dt>{tr('费用', 'Cost')}</dt><dd>{tr('未知（无可靠计价）', 'Unknown (no verified price)')}</dd></div>
          {worker.acceptance && <div><dt>{tr('验收', 'Acceptance')}</dt><dd>{worker.acceptance.status === 'accepted' ? tr('已验收', 'Accepted') : tr('待主 Agent 验收', 'Awaiting Main review')}</dd></div>}
          {!!worker.dependsOn?.length && <div><dt>{tr('依赖', 'Dependencies')}</dt><dd>{worker.dependsOn.join(', ')}</dd></div>}
          {!!worker.scope?.length && <div><dt>{tr('范围', 'Scope')}</dt><dd>{worker.scope.join(', ')}</dd></div>}
          {!!worker.configuration?.tools?.length && <div><dt>{tr('可用工具', 'Available tools')}</dt><dd>{worker.configuration.tools.join(', ')}</dd></div>}
          {!!worker.changedFiles?.length && <div><dt>{tr('修改文件', 'Changed files')}</dt><dd>{worker.changedFiles.map(change => change.path).join(', ')}</dd></div>}
        </dl>
        {worker.summary && <p className="pa-result">{worker.summary}</p>}
        {enabled ? <form onSubmit={event => { event.preventDefault(); void action('steer', worker); }}>
          <textarea aria-label={tr('追加要求', 'Additional instructions')} rows={2} maxLength={4000} value={guidance[worker.agentId] || ''} onChange={event => setGuidance(value => ({ ...value, [worker.agentId]: event.target.value }))} placeholder={tr('给这个 Agent 追加要求…', 'Additional instructions for this Agent…')} />
          <div className="pa-actions"><button type="submit" disabled={Boolean(pending) || !guidance[worker.agentId]?.trim()}>{tr('追加要求', 'Send guidance')}</button><button type="button" disabled={Boolean(pending) || worker.status !== 'running'} onClick={() => void action('stop', worker)}>{tr('停止此 Agent', 'Stop this Agent')}</button></div>
        </form> : <small>{tr('本轮已结束；如需继续，请在主聊天发送下一轮要求。', 'This run has ended. Send another message in Main to continue.')}</small>}
      </div>
    </details>)}
    {notice && <p role="status">{notice}</p>}
  </section>;
}

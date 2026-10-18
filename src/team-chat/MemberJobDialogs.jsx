import { SideChatDialog } from '../workbench/SideChatDialog.jsx';
import { AgentAvatar } from '../components/AgentAvatar.jsx';

export function MemberJobDialogs({ kind, onClose, tr, roles, group, profile, target, setTarget, text, setText, draft, setDraft, jobs, workspacePath, busy, error, setError, prepare, act, statusLabel, openNew }) {
  const name = job => roles.find(role => role.id === job.roleId)?.name || job.roleName;
  if (kind === 'job') return <SideChatDialog className="tm-dialog tm-job-dialog" title={tr('交给成员独立处理', 'Assign a member job')} subtitle={tr('不进入主任务。确认后独立执行，结果回到此会话。', 'Separate from the main task. Results return to this conversation.')} onClose={onClose}
    footer={<><button disabled={busy} onClick={onClose}>{tr('取消', 'Cancel')}</button>{draft ? <button disabled={busy} onClick={() => act('jobs:start', draft)}>{tr('确认启动', 'Confirm and start')}</button> : <button disabled={busy || !text.trim() || !target} onClick={prepare}>{tr('核对任务', 'Review job')}</button>}</>}>
    {draft ? <div className="tm-job-review"><strong>{name(draft)}</strong><p>{draft.instruction}</p><small>{draft.workspacePath}<br />{draft.modelId}</small><p className="tm-setting-note">{tr('仅使用此角色的原生工具，不开放浏览器或 MCP。涉及写文件或命令时使用独立副本；命令仍需审批，使用本机权限与网络，不是系统级沙箱。不会自动覆盖原项目。', 'Uses this role’s native tools, without browser or MCP access. Writes and commands use a separate copy. Commands require approval and use host permissions/network, not an OS sandbox. The source project is not overwritten automatically.')}</p><button className="tm-menu-action" disabled={busy} onClick={() => setDraft(null)}>{tr('返回修改', 'Edit draft')}</button></div>
      : <><label className="tm-setting"><span>{tr('受领成员', 'Member')}</span><select aria-label={tr('受领成员', 'Member')} value={target} disabled={busy || !group} onChange={e => setTarget(e.target.value)}>{roles.filter(role => role.enabled && (group || role.id === profile?.id)).map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
        <label className="tm-job-label">{tr('工作目标', 'Instruction')}<textarea className="tm-transfer-editor" aria-label={tr('独立任务目标', 'Member job instruction')} value={text} disabled={busy} maxLength={8000} onChange={e => setText(e.target.value)} /></label>
        <p className="tm-setting-note">{tr('目录以聊天设置中的工作背景为准，确认页会再次显示。', 'Uses the work context selected in chat settings; the confirmation shows the exact directory.')}{workspacePath ? '' : tr(' 无目录时不能启动。', ' A workspace is required.')}</p></>}
    {error && <p className="tm-error" role="alert">{error}</p>}
  </SideChatDialog>;
  if (kind !== 'jobs') return null;
  return <SideChatDialog className="tm-dialog tm-job-dialog" title={tr('成员独立任务', 'Member jobs')} subtitle={tr('独立记录与审批，不改变主任务状态。', 'Own records and approvals; the main task stays unchanged.')} onClose={onClose}>
    <button className="tm-menu-action" onClick={openNew}>{tr('派发新任务', 'Assign a new job')}</button>
    {error && <p className="tm-error" role="alert">{error}</p>}
    {!jobs.length && <p className="tm-setting-note">{tr('此会话还没有成员任务。', 'No member jobs in this conversation.')}</p>}
    {jobs.slice().reverse().map(job => <article key={job.id} className="tm-job-item" data-job-status={job.status}>
      <header><AgentAvatar template={roles.find(role => role.id === job.roleId)?.template || job.roleTemplate || job.roleId} /><strong>{name(job)}</strong><small>{statusLabel(job.status)}</small></header>
      <p>{job.instruction}</p>
      {job.result && <p className="tm-job-result">{job.result.content}</p>}
      {job.result?.workspace?.mergeRequired && <p className="tm-setting-note">{tr('成果在独立副本中，未覆盖原项目。', 'Results are in a separate copy, not applied to the source project.')}</p>}
      {job.approval && <div className="tm-job-approval"><strong>{job.approval.title || tr('需要你确认', 'Approval required')}</strong><pre>{job.approval.command || job.approval.reason}</pre><div className="tm-job-actions"><button disabled={busy} onClick={() => act('jobs:approve', job, { approvalId: job.approval.id, approved: false })}>{tr('拒绝', 'Reject')}</button><button disabled={busy} onClick={() => act('jobs:approve', job, { approvalId: job.approval.id, approved: true })}>{tr('允许这一次', 'Allow once')}</button></div></div>}
      <div className="tm-job-actions">
        {job.status === 'draft' && <button disabled={busy} onClick={() => act('jobs:start', job)}>{tr('启动', 'Start')}</button>}
        {['draft', 'queued', 'running', 'waiting_approval'].includes(job.status) && <button disabled={busy} onClick={() => act('jobs:cancel', job)}>{tr('取消任务', 'Cancel job')}</button>}
        {job.resultDirectory && <button onClick={async () => { try { if (!window.desktop?.openWorkspace) throw new Error(tr('此预览不能打开本地目录。', 'Local folders cannot be opened in this preview.')); await window.desktop.openWorkspace(job.resultDirectory); } catch (e) { setError(e.message); } }}>{tr('打开工作目录', 'Open workspace')}</button>}
      </div>
    </article>)}
  </SideChatDialog>;
}

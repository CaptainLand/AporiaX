import React, { useState } from 'react';
import { useI18n } from '../i18n';
import { taskApprovalMode } from '../state/approval-mode.js';
import { taskExecutionMode } from '../state/execution-mode.js';
import { GlobalFilePermissionsPanel } from './GlobalFilePermissionsPanel.jsx';
import './permissions-settings.css';

function PermissionChoices({ id, label, value, disabled, options, onChange }) {
  return <div id={id} className="permission-choices" role="group" aria-label={label}>
    {options.map(([key, name]) => <button type="button" key={key} aria-pressed={value === key} disabled={disabled} onClick={() => onChange(key)}>{name}</button>)}
  </div>;
}

export function PermissionsSettings({ task, onUpdateTask, sandboxStatus, sandboxPreparing, onPrepareSandbox }) {
  const { tr } = useI18n();
  const [error, setError] = useState('');
  const approval = taskApprovalMode(task?.approvalMode);
  const execution = taskExecutionMode(task?.executionMode);
  const approvalHelp = approval === 'full-auto'
    ? tr('高权限操作可自动执行；受保护操作仍需确认。', 'High-privilege actions may run automatically; protected actions still require confirmation.')
    : approval === 'smart-auto'
      ? tr('已识别的低风险操作自动执行，其他操作请求确认。', 'Recognized low-risk actions run automatically; other actions request confirmation.')
      : tr('需要审批的操作逐次请求确认。', 'Actions requiring approval request confirmation each time.');
  const executionHelp = execution === 'direct'
    ? tr('直接修改真实工作区，不创建临时副本。', 'Works directly in the real workspace without a temporary copy.')
    : execution === 'safe'
      ? tr('在临时副本执行，冲突检查后同步；仍使用本机网络和进程权限。', 'Runs in a temporary copy and syncs after conflict checks; host network and process permissions remain available.')
      : tr('仅在 Docker 隔离环境执行，不会自动降级到本机。', 'Runs only inside Docker isolation, with no automatic host fallback.');
  const openRecovery = async () => {
    setError('');
    try {
      if (!window.desktop?.sandbox?.openRecovery) throw new Error(tr('请使用更新后的桌面端。', 'Use the updated desktop app.'));
      await window.desktop.sandbox.openRecovery();
    } catch (failure) { setError(failure.message); }
  };
  return <div className="permissions-settings">
    <header><h3>{tr('权限与审批', 'Permissions & approvals')}</h3>
      <p>{task ? tr('当前任务：{name} · 修改在下次运行生效', 'Current task: {name} · Changes apply to the next run', { name: task.title })
        : tr('打开一个任务后，可配置它的审批和执行环境。', 'Open a task to configure its approvals and execution environment.')}</p>
    </header>
    <section aria-label={tr('当前任务权限', 'Current task permissions')}>
      <div className="permission-setting-row">
        <div><strong>{tr('操作审批', 'Action approvals')}</strong><p>{task ? approvalHelp : tr('未选择任务', 'No task selected')}</p></div>
        <PermissionChoices id="permission-approval" label={tr('操作审批', 'Action approvals')} value={approval} disabled={!task} onChange={approvalMode => onUpdateTask({ approvalMode })}
          options={[[ 'full-auto', tr('自动执行', 'Automatic') ], [ 'smart-auto', tr('智能确认', 'Smart') ], [ 'manual', tr('逐次确认', 'Each time') ]]} />
      </div>
      <div className="permission-setting-row">
        <div><strong>{tr('执行环境', 'Execution environment')}</strong><p>{task ? executionHelp : tr('未选择任务', 'No task selected')}</p></div>
        <PermissionChoices id="permission-execution" label={tr('执行环境', 'Execution environment')} value={execution} disabled={!task} onChange={executionMode => onUpdateTask({ executionMode })}
          options={[[ 'direct', tr('直接', 'Direct') ], [ 'safe', tr('安全副本', 'Safe copy') ], [ 'isolated', tr('隔离', 'Isolated') ]]} />
      </div>
      {task && execution === 'isolated' && <div className="permission-environment">
        <span>{sandboxStatus?.available ? tr('Docker 已就绪', 'Docker ready') : tr('Docker 尚未就绪', 'Docker not ready')}</span>
        {!sandboxStatus?.available && <button type="button" disabled={sandboxPreparing} onClick={onPrepareSandbox}>{sandboxPreparing ? tr('正在准备…', 'Preparing…') : tr('准备隔离环境', 'Prepare isolation')}</button>}
      </div>}
    </section>
    <section aria-label={tr('全局权限', 'Global permissions')}>
      <GlobalFilePermissionsPanel embedded />
      <div className="permission-setting-row"><div><strong>{tr('沙箱恢复目录', 'Sandbox recovery folders')}</strong><p>{tr('查看安全副本中保留的冲突、中断与失败产物。', 'View retained output from conflicted, interrupted or failed safe-copy runs.')}</p></div>
        <button type="button" onClick={() => void openRecovery()}>{tr('打开', 'Open')}</button>
      </div>
    </section>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <details><summary>{tr('权限边界与风险', 'Permission boundaries and risks')}</summary><p>{tr('自动执行不会解除权限边界。越界或不明删除、异常恢复以及专业角色的创建、修改、删除仍需确认；明确拒绝的工具不会放行。审批模式不是操作系统级沙箱，不能保证拦截脚本或 MCP 的间接删除。', 'Automatic execution does not remove permission boundaries. External or ambiguous deletion, uncertain recovery and professional-role creation, edits and deletion still require confirmation. Explicitly denied tools remain denied. Approval mode is not an OS sandbox and cannot guarantee blocking indirect deletion by scripts or MCP.')}</p></details>
  </div>;
}

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { APPROVE_ALL_MODE } from '../../shared/approval-modes.js';
import { useI18n } from '../i18n';
import './approve-all-warning.css';

export function useTaskApprovalChoice(task, mode, updateTask) {
  const [pendingTask, setPendingTask] = useState(null);
  useEffect(() => { setPendingTask(null); }, [task?.id]);
  const dismiss = () => setPendingTask(null);
  const warning = task?.id && pendingTask === task.id && mode !== APPROVE_ALL_MODE
    ? <ApproveAllWarning isolated={task.executionMode === 'isolated'} onDismiss={dismiss} onConfirm={() => {
      dismiss();
      updateTask({ approvalMode: APPROVE_ALL_MODE });
    }} /> : null;
  return {
    warning,
    selectApproval(value) {
      dismiss();
      if (!task?.id || mode === value) return;
      if (value === APPROVE_ALL_MODE) setPendingTask(task.id);
      else updateTask({ approvalMode: value });
    },
  };
}

function ApproveAllWarning({ isolated, onDismiss, onConfirm }) {
  const { tr } = useI18n();
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const titleId = useId(), descriptionId = useId();
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement;
    dialog.showModal();
    cancelRef.current.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialogRef} className="approve-all-warning" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onDismiss(); }}>
    <div className="approve-all-warning-title"><AlertTriangle size={18} aria-hidden="true" /><h3 id={titleId}>{tr('开启「一律通过」？', 'Enable Always allow?')}</h3></div>
    <div id={descriptionId}>
      <p>{tr('仅对当前任务生效，下次运行开始。Agent 可以不经逐次审批修改文件、运行已授权的命令，以及删除单个工作区文件（保留恢复快照）。', 'Only applies to this task, starting with its next run. The Agent can edit files, run authorized commands, and delete individual workspace files with recovery snapshots without asking each time.')}</p>
      <p>{isolated ? tr('保留隔离环境，不会降级到本机。', 'Isolation stays on, with no fallback to the host.') : tr('直接与安全副本模式的命令仍使用本机进程和网络权限。请只在信任的项目中使用。', 'Commands in Direct and Safe copy modes still have host process and network access. Only use this with projects you trust.')}</p>
      <p>{tr('工作区外文件操作和需要另行授权的动作会跳过，不会弹出审批。', 'File operations outside the workspace and actions that require separate authorization will be skipped without an approval prompt.')}</p>
    </div>
    <div className="approve-all-warning-actions">
      <button ref={cancelRef} type="button" onClick={onDismiss}>{tr('取消', 'Cancel')}</button>
      <button type="button" onClick={onConfirm}>{tr('了解风险，开启', 'Accept risk and enable')}</button>
    </div>
  </dialog>;
}

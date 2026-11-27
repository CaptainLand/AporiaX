import { useId, useState } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../i18n';
import './stopped-run-notice.css';

export function StoppedRunNotice({ messageId, changeCount, taskRunning, onResume, onDismiss, deferOffscreen, children }) {
  const { tr } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [resuming, setResuming] = useState(false);
  const detailsId = useId();
  const resume = async () => {
    if (resuming || taskRunning) return;
    setResuming(true);
    try { await onResume(); }
    catch (error) { console.error('AporiaX resume action failed', error); }
    finally { setResuming(false); }
  };

  return <section className="stopped-run-notice" data-thread-turn={messageId} data-defer-offscreen={deferOffscreen || undefined}>
    <div className="stopped-run-line">
      <span className="stopped-run-label"><strong>{tr('已停止', 'Stopped')}</strong>{changeCount > 0 && <span>{tr(' · 保留了 {count} 项文件改动', changeCount === 1 ? ' · {count} file change kept' : ' · {count} file changes kept', { count: changeCount })}</span>}</span>
      <span className="stopped-run-actions">
        <button type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(open => !open)}>{expanded ? tr('收起', 'Hide') : tr('查看', 'View')}</button>
        {onResume && <button type="button" disabled={resuming || taskRunning} onClick={resume}
          title={taskRunning ? tr('当前任务仍在运行', 'The task is still running') : undefined}>{resuming ? tr('恢复中…', 'Resuming…') : tr('恢复', 'Resume')}</button>}
        {onDismiss && <button className="stopped-run-dismiss" type="button" aria-label={tr('不再显示这条停止提示', 'Dismiss this stopped-run notice permanently')}
          title={tr('不再显示此提示 · 执行记录仍保留', 'Hide this notice; the execution record is kept')} onClick={onDismiss}><X size={14} aria-hidden="true" /></button>}
      </span>
    </div>
    <div id={detailsId} className="stopped-run-details" hidden={!expanded}>{expanded ? children : null}</div>
  </section>;
}

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useI18n } from '../i18n';
import { reportedRunUsage, reportedUncachedInputTokens } from '../../shared/model-progress-view.js';

export function RouteTokenUsage({ run, taskId, live }) {
  const { tr, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(null);
  const [request, setRequest] = useState(null);
  const [error, setError] = useState(false);
  const pendingFinalRefresh = useRef(false);
  const available = Boolean(run.runId && window.desktop?.harness?.modelUsage);
  const number = new Intl.NumberFormat(language);
  const percent = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 });
  const n = value => Number.isSafeInteger(value) && value >= 0 ? number.format(value) : '—';
  const rate = value => value == null ? '—' : percent.format(value);
  const usage = reportedRunUsage(run.usage, { partial: run.usagePartial });

  useEffect(() => {
    if (!request || !available) return;
    let active = true;
    const { afterSequence } = request;
    window.desktop.harness.modelUsage({ taskId, runId: run.runId, afterSequence }).then(result => {
      if (!active) return;
      setPage(previous => ({ ...result, entries: afterSequence ? [...(previous?.entries || []), ...result.entries] : result.entries }));
    }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setRequest(null); });
    return () => { active = false; };
  }, [request, taskId, run.runId, available]);

  useEffect(() => {
    if (live) pendingFinalRefresh.current = true;
    else if (open && page && !page.hasMore && !request && pendingFinalRefresh.current) {
      pendingFinalRefresh.current = false;
      setError(false);
      setRequest({ afterSequence: page.nextSequence || 0 });
    }
  }, [live, open, page, request]);

  const load = (afterSequence = 0) => {
    setError(false);
    setRequest({ afterSequence });
  };
  const toggle = () => {
    if (!open && !page && !request) load();
    setOpen(!open);
  };

  return <section className="ra-usage" aria-label={tr('本轮 Token 用量', 'Token usage in this run')}>
    <div className="ra-usage-heading">
      <div><h3>{tr('Token 用量', 'Token usage')}</h3>
        {usage ? <p>
          <span>{tr(usage.partial ? '已记录 {count} Token' : '共 {count} Token', usage.partial ? '{count} recorded Token' : '{count} Token total', { count: n(usage.total) })}</span>
          <span>↑ {n(run.usagePartial ? null : reportedUncachedInputTokens(run.usage))} {tr('未命中', 'uncached')}</span>
          <span>↓ {n(run.usage.completion_tokens ?? run.usage.output_tokens)} {tr('输出', 'output')}</span>
          <span>{tr('缓存命中 {count}（{rate}）', 'Cache hits {count} ({rate})', { count: usage.hits != null && usage.incompleteCache ? `≥${n(usage.hits)}` : n(usage.hits), rate: rate(usage.hitRate) })}</span>
        </p> : <p>{live ? tr('本轮结束后显示汇总。', 'The total will appear when this run ends.') : tr('未记录本轮用量。', 'No usage total recorded for this run.')}</p>}
      </div>
      {available && <button type="button" className="ra-history-toggle" aria-expanded={open} onClick={toggle}>
        {open ? tr('收起调用明细', 'Hide model calls') : tr('查看调用明细', 'View model calls')}<ChevronDown size={14} />
      </button>}
    </div>
    {open && <div className="ra-usage-details">
      <p>{tr('每行是一条模型请求记录，含子 Agent 和重试；「—」表示服务商未回传数据。', 'One row per model request attempt, including subagents and retries. “—” means usage was not reported.')}</p>
      {!!page?.entries.length && <div className="ra-usage-table-scroll" tabIndex={0} aria-label={tr('模型调用明细', 'Model call breakdown')}>
        <table className="ra-usage-table">
          <thead><tr>{[tr('调用', 'Call'), tr('总输入', 'All input'), tr('↑ 未命中', '↑ Uncached'), tr('↓ 输出', '↓ Output'), tr('缓存命中率', 'Cache hit rate')].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{page.entries.map((entry, index) => <tr key={entry.sequence}>
            <th scope="row"><span>{index + 1} · {entry.actor === 'subagent' ? tr('子 Agent', 'Subagent') : 'AporiaX'}</span>{(entry.inherited || entry.attempt > 1 || entry.status === 'failed') && <small>
              {[entry.inherited && tr('接续前', 'Before resume'), entry.attempt > 1 && tr('第 {count} 次尝试', 'Attempt {count}', { count: entry.attempt }), entry.status === 'failed' && tr('失败', 'Failed')].filter(Boolean).join(' · ')}
            </small>}</th>
            <td>{n(entry.usage?.prompt_tokens)}</td><td>{n(reportedUncachedInputTokens(entry.usage))}</td><td>{n(entry.usage?.completion_tokens)}</td><td>{rate(reportedRunUsage(entry.usage)?.hitRate)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {!request && !error && page?.entries.length === 0 && <p>{tr('暂无已保存的模型调用明细。', 'No saved model call details.')}</p>}
      {request && <p role="status">{tr('正在读取用量记录…', 'Loading model call usage…')}</p>}
      {error && <p role="alert">{tr('读取用量记录失败，可以重试。', 'Could not load model call usage. Try again.')}</p>}
      {(page?.hasMore || live || error) && <button type="button" className="ra-load-older" disabled={Boolean(request)} onClick={() => load(page?.nextSequence || 0)}>
        {page?.hasMore ? tr('显示更多调用', 'Show more calls') : tr('刷新调用明细', 'Refresh model calls')}
      </button>}
    </div>}
  </section>;
}

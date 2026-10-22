import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, LogIn, RefreshCw } from 'lucide-react';
import { useAccount } from '../account/AccountContext.jsx';
import { useI18n } from '../i18n.jsx';
import { accountErrorText } from '../account/account-errors.js';
import { quotaResetLabel } from '../account/quota-reset.js';
import { useRequestHistory } from '../account/useRequestHistory.js';
import { summarizeUsage, usageCalendar, usageDay } from '../account/usage-model.js';
import './account-settings.css';
import { AccountAvatar } from '../account/AccountAvatar.jsx';
import { AccountAvatarPicker } from '../account/AccountAvatarPicker.jsx';

const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
const ratio = value => typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 4 })}%` : '—';
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '—';
const duration = value => typeof value === 'number' && Number.isFinite(value) ? value < 1000 ? `${value} ms` : `${number(value / 1000)} s` : '—';

export function AccountSettings() {
  const context = useAccount();
  const owner = context.account?.status === 'authenticated' ? context.account.profile?.id : null;
  // Unmount all account-specific state before displaying a different identity.
  return <AccountSettingsContent key={`${owner || 'anonymous'}:${context.account?.session?.id || ''}`} context={context} owner={owner} />;
}

function AccountSettingsContent({ context, owner }) {
  const { tr } = useI18n();
  const { account, busy, error, api, signIn, refresh, signOut } = context;
  const history = useRequestHistory(api, owner);
  const [webBusy, setWebBusy] = useState(false), [webError, setWebError] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [year, setYear] = useState(() => Number(usageDay(Date.now()).slice(0, 4)));
  const [metric, setMetric] = useState('tokens'), [day, setDay] = useState(''), [status, setStatus] = useState('all'), [page, setPage] = useState(0);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer); }, []);
  const stats = useMemo(() => summarizeUsage(history.rows), [history.rows]);
  const calendar = useMemo(() => usageCalendar({ rows: history.rows, complete: history.complete, sampledAt: history.sampledAt, year, metric }), [history.rows, history.complete, history.sampledAt, year, metric]);
  const calendarColumns = Math.ceil((calendar.days.length + calendar.offset) / 7);
  const filtered = useMemo(() => history.rows.filter(row => (!day || usageDay(row.startedAt) === day) && (status === 'all' || row.billingStatus === status)), [history.rows, day, status]);
  useEffect(() => setPage(0), [day, status]);
  const labels = { settled: tr('已结算', 'Settled'), processing: tr('处理中', 'Processing'), pending: tr('待核对', 'Pending'), unbilled: tr('未计费', 'Unbilled') };
  const remaining = typeof account.quota?.remainingRatio === 'number' && Number.isFinite(account.quota.remainingRatio) ? Math.max(0, account.quota.remainingRatio) : null;
  const currentYear = Number(usageDay(now).slice(0, 4));
  const oldestYear = history.rows.length ? Math.min(...history.rows.map(row => Number(usageDay(row.startedAt).slice(0, 4)))) : currentYear;
  const openWeb = async () => {
    if (webBusy || !api?.openCenter) return;
    setWebBusy(true); setWebError(false);
    try { await api.openCenter(); } catch { setWebError(true); } finally { setWebBusy(false); }
  };
  const refreshAll = () => { setPage(0); void refresh(); void history.refresh(); };
  return <div className="account-settings">
    <header className="account-settings-heading">
      <div><h3>{tr('账户', 'Account')}</h3><p>{tr('账户信息与 Aporia Cloud 用量', 'Your account and Aporia Cloud usage')}</p></div>
      <button type="button" onClick={openWeb} disabled={webBusy || !api?.openCenter}><ExternalLink size={14} />{tr('网页账户', 'Account website')}</button>
    </header>
    {webError && <p role="alert">{tr('无法打开网页账户，请检查默认浏览器后重试。', 'Could not open the account website. Check your browser and retry.')}</p>}
    {error && <p role="alert">{accountErrorText(error, tr)}</p>}
    {!owner ? <div className="account-settings-empty">
      <AccountAvatar className="account-settings-empty-avatar" /><h4>{tr('连接你的 AporiaX 账户', 'Connect your AporiaX account')}</h4>
      <p>{tr('登录后查看 Cloud 额度、请求历史与每日用量。自定义 API 不计入这里。', 'Sign in to see Cloud quota, requests and daily usage. Custom APIs are not included.')}</p>
      <button type="button" disabled={busy || account.status === 'booting' || !api?.signIn} onClick={signIn}><LogIn size={14} />{busy || account.status === 'booting' ? tr('正在连接…', 'Connecting…') : tr('登录账户', 'Sign in')}</button>
    </div> : <>
      <section className="account-settings-profile">
        <AccountAvatarPicker />
        <div><strong>{account.profile.displayName || tr('AporiaX 用户', 'AporiaX user')}</strong><span>{account.profile.email || tr('已登录', 'Signed in')}</span><small>{account.device?.name || tr('当前设备', 'This device')}</small></div>
        <button type="button" disabled={busy || history.busy} onClick={refreshAll} aria-label={tr('刷新账户与用量', 'Refresh account and usage')}><RefreshCw size={14} />{tr('刷新', 'Refresh')}</button>
      </section>
      <section className="account-settings-quota" aria-label={tr('周额度', 'Weekly quota')}>
        <div><span>{tr('本周剩余额度', 'Weekly quota remaining')}</span><strong>{ratio(remaining)}</strong></div>
        <div className="account-settings-track" role="progressbar" aria-label={tr('本周剩余额度', 'Weekly quota remaining')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining == null ? undefined : Math.round(Math.min(1, remaining) * 100)} aria-valuetext={ratio(remaining)}><i style={{ width: remaining == null ? 0 : `${Math.min(1, remaining) * 100}%` }} /></div>
        <small>{quotaResetLabel(account.quota, now, tr)}</small>
      </section>
      <section className="account-settings-usage" aria-busy={history.busy}>
        <div className="account-settings-section-head"><h4>{history.complete ? tr('累计用量', 'Cumulative usage') : tr('已加载用量', 'Loaded usage')}</h4>
          {history.busy ? <button type="button" onClick={history.stop}>{tr('停止加载', 'Stop loading')}</button>
            : !history.complete && <button type="button" disabled={history.rows.length >= 10000} onClick={history.loaded ? history.sync : history.refresh}>{tr('同步历史', 'Sync history')}</button>}
        </div>
        <div className="account-settings-stats">
          <div><span>{tr('请求次数', 'Requests')}</span><strong>{history.loaded ? number(stats.requests) : '—'}</strong></div>
          <div><span>{tr('输入 Token', 'Input tokens')}</span><strong>{history.loaded ? number(stats.input) : '—'}</strong></div>
          <div><span>{tr('输出 Token', 'Output tokens')}</span><strong>{history.loaded ? number(stats.output) : '—'}</strong></div>
          <div><span>{tr('总 Token', 'Total tokens')}</span><strong>{history.loaded ? number(stats.input + stats.output) : '—'}</strong></div>
        </div>
        <p className="account-settings-note">{history.complete ? tr('已读取接口可提供的全部 Cloud 请求记录。Token 仅统计已结算记录，缓存 Token 已包含在输入中。', 'All Cloud request records available from the API are loaded. Tokens count settled records only; cached tokens are included in input.') : tr('仅统计已加载记录，并非账户总量。同步历史每次最多读取 2,000 条，可继续同步。', 'These are loaded records, not account totals. Each sync reads up to 2,000 records; you can continue syncing.')}
          {history.loaded && ` ${tr('待核对 / 处理中：{n}', 'Pending / processing: {n}', { n: stats.pending })}`}
          {stats.missingTokens > 0 && ` · ${tr('缺少 Token 数据：{n} 条', 'Missing token data: {n} records', { n: stats.missingTokens })}`}
        </p>
        {history.rows.length >= 10000 && !history.complete && <p role="status">{tr('已达到本次 10,000 条加载上限；更早记录请前往网页账户查看。', 'This view reached its 10,000-record limit. Open the account website for older records.')}</p>}
        {history.error && <p role="alert">{history.error === 'unavailable' ? tr('当前服务暂不支持请求历史，请更新桌面或前往网页账户。', 'Request history is unavailable. Update the desktop app or open your account website.') : tr('记录加载失败，已读取的数据仍保留，请重试同步或刷新。', 'Loading failed. Loaded records are retained; retry sync or refresh.')}</p>}
        {history.busy && <p className="account-settings-note" role="status">{tr('正在读取记录… 已加载 {n} 条', 'Loading records… {n} loaded', { n: history.rows.length })}</p>}
      </section>
      <section className="account-settings-activity">
        <div className="account-settings-section-head"><h4>{tr('每日用量', 'Daily usage')}</h4><div>
          <select aria-label={tr('日历指标', 'Calendar metric')} value={metric} onChange={event => setMetric(event.target.value)}><option value="tokens">Token</option><option value="quota">{tr('额度', 'Quota')}</option></select>
          <select aria-label={tr('日历年份', 'Calendar year')} value={year} onChange={event => { setYear(Number(event.target.value)); setDay(''); }}>
            {Array.from({ length: currentYear - Math.min(oldestYear, currentYear - 1) + 1 }, (_, i) => currentYear - i).map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </div></div>
        <div className="account-activity-scroll" style={{ '--activity-columns': calendarColumns }}><div className="account-activity-months">{Array.from({ length: 12 }, (_, i) => <span key={i} style={{ gridColumn: Math.floor((calendar.days.findIndex(entry => entry.day === `${year}-${String(i + 1).padStart(2, '0')}-01`) + calendar.offset) / 7) + 1 }}>{tr('{n}月', '{n}', { n: i + 1 })}</span>)}</div>
          <div className="account-activity-grid" aria-label={tr('每日用量日历，北京时间', 'Daily usage calendar, Beijing time')}>
            {Array.from({ length: calendar.offset }, (_, i) => <i key={`pad-${i}`} />)}
            {calendar.days.map((entry, index) => {
              const hint = `${entry.day} · ${entry.future ? tr('未来日期', 'Future date') : !entry.covered ? tr('尚未完整加载', 'Not fully loaded') : ''}${!entry.future ? ` ${metric === 'tokens' ? `${number(entry.value)} Token` : `${number(entry.value)} ${tr('份基础周额度', 'base weekly allowances')}`} · ${entry.stats.requests} ${tr('次请求', 'requests')}${entry.unknown ? ` · ${tr('不完整 / 待核对', 'Incomplete / pending')}` : ''}` : ''}`;
              return <button key={entry.day} type="button" tabIndex={entry.day === (day || (year === Number(usageDay(history.sampledAt)?.slice(0, 4)) ? usageDay(history.sampledAt) : `${year}-01-01`)) ? 0 : -1} data-index={index} data-level={entry.level} data-unknown={entry.unknown && !entry.future} data-future={entry.future} disabled={entry.future || !history.loaded} title={hint} aria-label={hint} aria-pressed={day === entry.day}
                onClick={() => { setDay(day === entry.day ? '' : entry.day); setPage(0); }}
                onKeyDown={event => { const offset = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key]; if (offset) { event.preventDefault(); event.currentTarget.parentElement.querySelector(`[data-index="${index + offset}"]:not(:disabled)`)?.focus(); } }} />;
            })}
          </div>
        </div>
        <div className="account-activity-legend"><span>{tr('少', 'Less')}</span>{[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level} />)}<span>{tr('多', 'More')}</span><i data-unknown="true" /><span>{tr('未完整 / 待核对', 'Incomplete / pending')}</span></div>
        <p className="account-settings-note">{tr('北京时间 · 点击日期筛选记录。', 'Beijing time · Select a date to filter requests.')} {metric === 'quota' ? tr('额度按请求所属周的基础额度折算；非周额度和未结算用量不计入。', 'Quota uses each request’s own base weekly allowance; non-weekly and unsettled usage is excluded.') : tr('色深表示已结算输入与输出 Token 之和。', 'Color shows settled input + output tokens.')}
          {calendar.max > 0 && ` ${tr('本年色阶上限：{n}', 'Yearly scale maximum: {n}', { n: number(calendar.max) })}`}
        </p>
      </section>
      <section className="account-settings-history">
        <div className="account-settings-section-head"><h4>{day || tr('请求历史', 'Request history')}</h4><div>{day && <button type="button" onClick={() => setDay('')}>{tr('清除日期', 'Clear date')}</button>}
          <select aria-label={tr('结算状态', 'Billing status')} value={status} onChange={event => setStatus(event.target.value)}><option value="all">{tr('全部状态', 'All statuses')}</option>{Object.entries(labels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select>
        </div></div>
        {!filtered.length && <p className="account-settings-note">{history.busy ? tr('正在加载…', 'Loading…') : history.complete ? tr('当前筛选下没有请求记录。', 'No requests match this filter.') : tr('已加载记录中暂无匹配项，可继续同步历史。', 'No matches in loaded records. Sync more history.')}</p>}
        {filtered.slice(page * 10, page * 10 + 10).map(row => <details className="account-request-row" key={row.requestId}>
          <summary><time dateTime={row.startedAt}>{time(row.startedAt).slice(5, 16)}</time><span className="account-request-model">{row.model || row.modelSlug || 'Aporia Cloud'}</span><span className="account-request-tokens">{number(row.tokens?.total)} <small>Token</small></span><span className="account-request-state" data-status={row.billingStatus}>{labels[row.billingStatus]}</span><ChevronDown size={13} /></summary>
          <dl><div><dt>{tr('输入 / 输出 Token', 'Input / output tokens')}</dt><dd>{number(row.tokens?.input)} / {number(row.tokens?.output)}</dd></div><div><dt>{tr('缓存命中', 'Cache hit')}</dt><dd>{number(row.tokens?.cachedInput)}</dd></div>
            <div><dt>{tr('所属周额度消耗', 'Own-week quota used')}</dt><dd>{ratio(row.quotaUsedRatio)}</dd></div><div><dt>{tr('总响应耗时', 'Total response time')}</dt><dd>{duration(row.responseTimeMs)}</dd></div><div><dt>{tr('首字时间', 'First token time')}</dt><dd>{tr('未记录', 'Not recorded')}</dd></div>
            <div><dt>{tr('设备', 'Device')}</dt><dd>{row.deviceName || '—'}</dd></div><div><dt>{tr('开始时间', 'Started')}</dt><dd>{time(row.startedAt)}</dd></div><div><dt>{tr('结束时间', 'Ended')}</dt><dd>{time(row.settledAt)}</dd></div><div><dt>{tr('请求 ID', 'Request ID')}</dt><dd>{row.requestId}</dd></div>
            {row.errorCode && <div><dt>{tr('错误代码', 'Error code')}</dt><dd>{row.errorCode}</dd></div>}
          </dl>
        </details>)}
        <footer className="account-history-pages"><small>{history.sampledAt ? tr('读取于 {time}（北京时间）', 'Loaded at {time} (Beijing)', { time: time(history.sampledAt) }) : ''}</small><div><button type="button" disabled={!page} onClick={() => setPage(value => value - 1)}>{tr('上一页', 'Previous')}</button><span>{page + 1} / {Math.max(1, Math.ceil(filtered.length / 10))}</span><button type="button" disabled={(page + 1) * 10 >= filtered.length} onClick={() => setPage(value => value + 1)}>{tr('下一页', 'Next')}</button></div></footer>
      </section>
      <div className="account-settings-bottom"><span>{tr('仅包含 Cloud 请求记录，不含自定义 API 用量。', 'Cloud request records only. Custom API usage is excluded.')}</span><button type="button" disabled={busy} onClick={() => { history.stop(); void signOut(); }}>{tr('退出登录', 'Sign out')}</button></div>
    </>}
  </div>;
}

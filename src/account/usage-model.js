export const USAGE_TIMEZONE = 'Asia/Shanghai';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: USAGE_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
export function usageDay(value) {
  if (value == null || value === '') return null;
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return null;
  const parts = Object.fromEntries(dayFormat.formatToParts(time).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function mergeUsageRows(previous, incoming) {
  return [...new Map([...previous, ...incoming].map(row => [row.requestId, row])).values()]
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.requestId.localeCompare(a.requestId));
}
const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function summarizeUsage(rows) {
  const result = { requests: rows.length, input: 0, output: 0, pending: 0, missingTokens: 0, quota: 0, missingQuota: 0, settled: 0 };
  for (const row of rows) {
    if (row.billingStatus === 'pending' || row.billingStatus === 'processing') result.pending++;
    if (row.billingStatus !== 'settled') continue;
    result.settled++;
    if (valid(row.tokens?.input) && valid(row.tokens?.output)) { result.input += row.tokens.input; result.output += row.tokens.output; }
    else result.missingTokens++;
    if (valid(row.quotaUsedRatio)) result.quota += row.quotaUsedRatio;
    else result.missingQuota++;
  }
  return result;
}
export function usageCalendar({ rows, complete, sampledAt, year, metric = 'tokens' }) {
  const today = usageDay(sampledAt);
  const oldest = rows.length ? rows.reduce((min, row) => Math.min(min, Date.parse(row.startedAt)), Infinity) : null;
  const firstLoadedDay = oldest == null ? null : usageDay(oldest);
  const byDay = new Map();
  for (const row of rows) {
    const day = usageDay(row.startedAt);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row);
  }
  const days = [];
  for (let time = Date.UTC(year, 0, 1); time < Date.UTC(year + 1, 0, 1); time += 86400000) {
    const day = new Date(time).toISOString().slice(0, 10);
    const stats = summarizeUsage(byDay.get(day) || []);
    const future = Boolean(today && day > today);
    // The oldest loaded day may be split across pages; never imply it is complete.
    const covered = Boolean(today && day <= today && (complete || (firstLoadedDay && day > firstLoadedDay)));
    const unknown = !covered || stats.pending > 0 || (metric === 'tokens' ? stats.missingTokens > 0 : stats.missingQuota > 0);
    days.push({ day, stats, future, covered, unknown, value: metric === 'tokens' ? stats.input + stats.output : stats.quota });
  }
  const max = Math.max(0, ...days.filter(day => !day.future).map(day => day.value));
  return { days: days.map(day => ({ ...day, level: day.value > 0 ? Math.max(1, Math.ceil(day.value / max * 4)) : 0 })), max,
    offset: (new Date(Date.UTC(year, 0, 1)).getUTCDay() + 6) % 7 };
}

export function quotaResetLabel(quota, now, tr) {
  if (quota?.activated === false) return tr('reset 未开始', 'reset not started');
  const end = typeof quota?.cycleEnd === 'string' ? Date.parse(quota.cycleEnd) : NaN;
  if (!Number.isFinite(end)) return 'reset —';
  if (end <= now) return tr('reset 待刷新', 'reset pending refresh');
  const minutes = Math.ceil((end - now) / 60000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  if (days) return tr('reset {d}天{h}小时', 'reset {d}d {h}h', { d: days, h: hours });
  if (hours) return tr('reset {h}小时{m}分', 'reset {h}h {m}m', { h: hours, m: rest });
  return tr('reset {m}分', 'reset {m}m', { m: minutes });
}

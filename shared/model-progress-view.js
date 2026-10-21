export function modelTokenLine(progress) {
  const count = (value, estimated) => Number.isFinite(value) && value >= 0 ? `${estimated !== false ? '≈' : ''}${Math.round(value).toLocaleString('en-US')}` : '—';
  return `↓ ${count(progress?.outputTokens, progress?.outputTokensEstimated)} Token`;
}

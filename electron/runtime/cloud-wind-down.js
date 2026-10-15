import { runtimeRunState, runtimeRecoveryContext, saveRuntimeContext } from './durable-run.js';

const SCOPE = 'cloud-quota-wind-down';
export const CLOUD_WIND_DOWN_PROMPT = '[Aporia Cloud low-quota wind-down]\n'
  + 'The last confirmed remaining weekly quota is at or below 5%. Enter wind-down mode for this run. '
  + 'Do not expand the task, delegate new agents, or start additional worker rounds. '
  + 'Prioritize safely saving existing work, collecting already-running results, and a concise handoff of completed work, '
  + 'unverified changes, unfinished items and next steps. Avoid expensive optional checks. '
  + 'Do not claim completion or successful verification without evidence; report partial work honestly. '
  + 'Existing permissions and required safety checks still apply. The runtime will preserve progress and pause if quota is exhausted.';
// Keep the original weekly prompt byte-for-byte stable for restored requests.
export const CLOUD_DAILY_WIND_DOWN_PROMPT = CLOUD_WIND_DOWN_PROMPT.replace(
  'remaining weekly quota', 'remaining shared daily provider budget');

function state() {
  return runtimeRunState(SCOPE, () => ({
    active: runtimeRecoveryContext(SCOPE)?.active === true,
    reason: runtimeRecoveryContext(SCOPE)?.reason || 'weekly',
    initialization: null, committed: Promise.resolve(),
  }));
}
export function lowCloudQuota(quota) {
  // No rounded UI percentage, no reserved/available amount, and no guessed
  // denominator for a pay-as-you-go wallet (which has no fixed allowance).
  return quota?.policy === 'actual-usage-v1' && quota.source === 'weekly' &&
    quota.exhausted === false && Number.isSafeInteger(quota.remainingMicros) && quota.remainingMicros > 0 &&
    Number.isSafeInteger(quota.limitMicros) && quota.limitMicros > 0 &&
    quota.remainingMicros <= Math.floor(quota.limitMicros / 20);
}
export const cloudWindDownActive = provider => provider?.kind === 'aporia-cloud' && state()?.active === true;
export function lowCloudDailyBudget(budget, now = Date.now()) {
  const sampledAt = Date.parse(budget?.sampledAt), resetsAt = Date.parse(budget?.resetsAt);
  return budget?.policy === 'provider-daily-v1' && budget.currency === 'CNY' &&
    Number.isSafeInteger(budget.remainingMicros) && budget.remainingMicros > 0 &&
    Number.isSafeInteger(budget.limitMicros) && budget.limitMicros > 0 &&
    budget.remainingMicros <= Math.floor(budget.limitMicros / 20) &&
    Number.isFinite(sampledAt) && sampledAt <= now + 30_000 && now - sampledAt <= 90_000 &&
    Number.isFinite(resetsAt) && resetsAt > now;
}
export async function observeCloudQuota(quota, onEvent) {
  const current = state();
  if (!current) return;
  if (current.active) { await current.committed; return; }
  const reason = lowCloudQuota(quota) ? 'weekly' : lowCloudDailyBudget(quota?.dailyBudget) ? 'daily' : null;
  if (!reason) return;
  const balance = reason === 'daily' ? quota.dailyBudget : quota;
  // Latch before yielding: parallel completions can only trigger this once.
  current.active = true;
  current.reason = reason;
  current.committed = saveRuntimeContext(SCOPE, { active: true, reason,
    remainingMicros: balance.remainingMicros, limitMicros: balance.limitMicros });
  await current.committed;
  onEvent?.({ type: 'response.quota.low', thresholdPercent: 5, mode: 'wind-down', source: reason });
}
export async function prepareCloudWindDown(provider, body, identity, onEvent, signal) {
  if (provider.kind !== 'aporia-cloud') return body;
  const current = state();
  if (!current) return body;
  // Seed once from authenticated capabilities. No model request is created.
  // A sent/restored request keeps its original prompt even if another worker
  // has since triggered wind-down: changing it would break idempotency.
  if (!current.active && !identity?.identity.fingerprint && !current.initialization && provider.getCloudQuota) {
    current.initialization = (async () => {
      let quota;
      try { quota = await provider.getCloudQuota(body.model, signal); }
      catch { return; } // Advisory read; billing remains authoritative. Never poison sibling requests on cancellation.
      await observeCloudQuota(quota, onEvent);
    })();
  }
  await current.initialization;
  signal?.throwIfAborted();
  await current.committed;
  const saved = identity?.identity;
  if (saved && saved.quotaWindDown === undefined) {
    saved.quotaWindDown = saved.fingerprint ? false : current.active;
    if (saved.quotaWindDown) saved.quotaWindDownReason = current.reason;
  }
  const active = saved ? saved.quotaWindDown : current.active;
  if (!active) return body;
  const reason = saved ? saved.quotaWindDownReason || 'weekly' : current.reason;
  const prompt = reason === 'daily' ? CLOUD_DAILY_WIND_DOWN_PROMPT : CLOUD_WIND_DOWN_PROMPT;
  const messages = [...body.messages];
  if (messages[0]?.role === 'system' && typeof messages[0].content === 'string')
    messages[0] = { ...messages[0], content: messages[0].content + '\n\n' + prompt };
  else messages.unshift({ role: 'system', content: prompt });
  return { ...body, messages };
}
export function cloudWorkerDeferral(provider) {
  if (!cloudWindDownActive(provider)) return null;
  return { status: 'partial', executed: false, reason: 'CLOUD_QUOTA_WIND_DOWN',
    summary: 'Cloud quota is low. No new worker activation was started. Save current work, collect existing results and report unfinished work honestly.' };
}

import { runtimeRunState, runtimeRecoveryContext, saveRuntimeContext } from './durable-run.js';
import { cloudRequestFingerprint } from './cloud-request-identity.js';

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
    warned: new Set(runtimeRecoveryContext(SCOPE)?.warned || (runtimeRecoveryContext(SCOPE)?.active
      ? [runtimeRecoveryContext(SCOPE).reason || 'weekly'] : [])),
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
  for (const source of [lowCloudQuota(quota) && 'weekly', lowCloudDailyBudget(quota?.dailyBudget) && 'daily']) {
    if (!source || current.warned.has(source)) continue;
    current.warned.add(source);
    const warned = [...current.warned];
    current.committed = current.committed.then(() => saveRuntimeContext(SCOPE, { warned })).catch(() => {});
    onEvent?.({ type: 'response.quota.low', thresholdPercent: 5, mode: 'advisory', source });
  }
  await current.committed;
}
export async function prepareCloudWindDown(provider, body, identity, onEvent, signal) {
  if (provider.kind !== 'aporia-cloud') return body;
  const current = state();
  if (!current) return body;
  // Seed once from authenticated capabilities. No model request is created.
  // All subsequent warnings come from receipts, not another lookup per worker.
  if (!identity?.identity.fingerprint && !current.initialization && provider.getCloudQuota) {
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
  // Only reproduce the exact original wire body of an already billed/in-flight
  // pre-upgrade request. New requests, even in restored runs, are advisory only.
  if (!saved?.fingerprint || !saved.quotaWindDown) return body;
  const reason = saved.quotaWindDownReason;
  const prompt = reason === 'daily' ? CLOUD_DAILY_WIND_DOWN_PROMPT : CLOUD_WIND_DOWN_PROMPT;
  const messages = [...body.messages];
  if (messages[0]?.role === 'system' && typeof messages[0].content === 'string')
    messages[0] = { ...messages[0], content: messages[0].content + '\n\n' + prompt };
  else messages.unshift({ role: 'system', content: prompt });
  const legacy = { ...body, messages };
  return cloudRequestFingerprint(provider, legacy) === saved.fingerprint ? legacy : body;
}

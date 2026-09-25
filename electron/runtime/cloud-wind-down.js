import { runtimeRunState, runtimeRecoveryContext, saveRuntimeContext } from './durable-run.js';

const SCOPE = 'cloud-quota-wind-down';
export const CLOUD_WIND_DOWN_PROMPT = '[Aporia Cloud low-quota wind-down]\n'
  + 'The last confirmed remaining weekly quota is at or below 5%. Enter wind-down mode for this run. '
  + 'Do not expand the task, delegate new agents, or start additional worker rounds. '
  + 'Prioritize safely saving existing work, collecting already-running results, and a concise handoff of completed work, '
  + 'unverified changes, unfinished items and next steps. Avoid expensive optional checks. '
  + 'Do not claim completion or successful verification without evidence; report partial work honestly. '
  + 'Existing permissions and required safety checks still apply. The runtime will preserve progress and pause if quota is exhausted.';

function state() {
  return runtimeRunState(SCOPE, () => ({
    active: runtimeRecoveryContext(SCOPE)?.active === true,
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
export async function observeCloudQuota(quota, onEvent) {
  const current = state();
  if (!current) return;
  if (current.active) { await current.committed; return; }
  if (!lowCloudQuota(quota)) return;
  // Latch before yielding: parallel completions can only trigger this once.
  current.active = true;
  current.committed = saveRuntimeContext(SCOPE, { active: true,
    remainingMicros: quota.remainingMicros, limitMicros: quota.limitMicros });
  await current.committed;
  onEvent?.({ type: 'response.quota.low', thresholdPercent: 5, mode: 'wind-down' });
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
  if (saved && saved.quotaWindDown === undefined)
    saved.quotaWindDown = saved.fingerprint ? false : current.active;
  const active = saved ? saved.quotaWindDown : current.active;
  if (!active) return body;
  const messages = [...body.messages];
  if (messages[0]?.role === 'system' && typeof messages[0].content === 'string')
    messages[0] = { ...messages[0], content: messages[0].content + '\n\n' + CLOUD_WIND_DOWN_PROMPT };
  else messages.unshift({ role: 'system', content: CLOUD_WIND_DOWN_PROMPT });
  return { ...body, messages };
}
export function cloudWorkerDeferral(provider) {
  if (!cloudWindDownActive(provider)) return null;
  return { status: 'partial', executed: false, reason: 'CLOUD_QUOTA_WIND_DOWN',
    summary: 'Cloud quota is low. No new worker activation was started. Save current work, collect existing results and report unfinished work honestly.' };
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeTokenUsage } from './token-usage.js';
const active = new AsyncLocalStorage();
const fail = message => Object.assign(new Error(`AGENT_BUDGET_EXHAUSTED: ${message}`), { code: 'AGENT_BUDGET_EXHAUSTED', retryable: false });
export function createRoleClock(control, elapsed = 0, queued = false) {
  const now = () => control?.activeNow?.() ?? Date.now();
  const started = now();
  let held = 0, holdStart = queued ? started : 0, depth = queued ? 1 : 0;
  let waiting = queued;
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  const hold = () => { if (!depth++) holdStart = now(); notify(); };
  const release = () => { if (depth && !--depth) held += now() - holdStart; notify(); };
  const activeNow = () => now() - held - (depth ? now() - holdStart : 0);
  return {
    get paused() { return Boolean(control?.paused || depth); },
    activeNow,
    elapsed: () => elapsed + activeNow() - started,
    onChange(listener) { listeners.add(listener); const off = control?.onChange?.(listener); return () => { listeners.delete(listener); off?.(); }; },
    start() { if (waiting) { waiting = false; release(); } },
    async approval(request) { hold(); try { return await request(); } finally { release(); } },
  };
}
export function createRoleLedger(saved) {
  return { requests: 0, tokens: 0, unknown: 0, reserved: 0, ...saved };
}
export function withRoleBudget(context, execute) { return active.run(context, execute); }
export async function beginRoleRequest(body) {
  const ctx = active.getStore();
  if (!ctx) return null;
  const { ledger, total, profile, limit, persist } = ctx;
  if (ledger.requests >= profile.maxRequests || total.requests >= limit) throw fail('请求次数已达到上限。');
  const estimated = Math.ceil(JSON.stringify(body.messages || []).length / 2) + Number(body.max_tokens || body.max_output_tokens || 8192);
  if (profile.maxTokens && ledger.tokens + ledger.reserved + estimated > profile.maxTokens) throw fail('剩余 Token 预算不足以发起下一次请求。');
  ledger.requests++; total.requests++; ledger.reserved += estimated;
  await persist?.(); // admission must be durable before sending paid work
  return { ctx, estimated, settled: false };
}
export async function finishRoleRequest(ticket, usage) {
  if (!ticket || ticket.settled) return;
  ticket.settled = true;
  const { ledger, persist, emit } = ticket.ctx;
  const amount = usage && ['input_tokens', 'prompt_tokens', 'total_tokens', 'promptTokens'].some(key => Number.isFinite(usage[key]))
    ? normalizeTokenUsage(usage)?.total_tokens : null;
  if (Number.isFinite(amount)) { ledger.tokens += amount; ledger.reserved -= ticket.estimated; }
  else ledger.unknown++; // retain reservation, never turn unknown usage into free budget
  emit?.({ ...ledger });
  await persist?.();
}

import assert from 'node:assert/strict';
import { getLiveRunProgress as progress } from '../src/conversation/witness-progress.js';

const steps = ['completed', 'in_progress', 'pending', 'blocked'].map((status, index) => ({ title: `Step ${index}`, status }));
const plan = { steps };
const running = progress({ status: 'running', plan });
assert.equal(running.completedCount, 1);
assert.equal(running.totalCount, 4);
assert.equal(running.blockedCount, 1);
assert.equal(running.progress, 25, 'in-progress steps receive no speculative credit');
assert.equal(running.currentEntry.title, 'Step 1');
for (const stage of ['route', 'forge', 'trial', 'deliver']) {
  assert.equal(progress({ status: 'running', route: Array(50).fill({ stage, status: 'completed' }) }).progress, null,
    'tool counts and stages cannot infer remaining work');
}
for (const status of ['partial', 'blocked', 'needs_input', 'failed', 'interrupted']) {
  const state = progress({ status, content: 'Reply delivered', replyDelivered: true, witness: { status: 'completed' } });
  assert.equal(state.completed, false, status);
  assert.equal(state.progress, null, status);
  assert.equal(state.active, false, status);
  assert.equal(state.finished, true, status);
}
for (const status of ['paused', 'waiting']) {
  const state = progress({ status: 'running', witness: { status, plan } });
  assert.equal(state.status, status);
  assert.equal(state.active, false);
  assert.equal(state.finished, false);
  assert.equal(state.progress, 25);
}
const allDone = { steps: [{ status: 'completed' }] };
assert.equal(progress({ status: 'running', plan: allDone }).progress, null, 'completed plan is not a completed task');
assert.equal(progress({ status: 'partial', plan: allDone }).progress, null);
assert.equal(progress({ status: 'completed', witness: { status: 'running' } }).progress, 100, 'final outcome supersedes stale observer snapshot');
assert.equal(progress({ status: 'running', witness: { status: 'completed' } }).progress, 100);
assert.equal(progress({ status: 'completed', error: true }).completed, false);
assert.equal(progress(null).progress, null);
console.log('PASS Witness progress: real plan counts, no stage/tool estimates, reply vs outcome, all terminal states, pause and final-event ordering.');

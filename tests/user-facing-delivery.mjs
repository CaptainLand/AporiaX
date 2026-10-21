import assert from 'node:assert/strict';
import { runHarness } from '../electron/agent-runtime-core.js';
import { readTaskOutcome } from '../electron/runtime/task-outcome.js';
import { sanitizeConversation, sanitizeFinalAnswer } from '../electron/runtime/conversation.js';
import { forkPublicHistory } from '../electron/side-chat/temporary-context.js';
import { sanitizeRunResult } from '../electron/run-store.js';
import { TOOL_DEFINITIONS } from '../electron/runtime/native-tool-catalog.js';
import { deliveryPresentation } from '../electron/runtime/workflow-policy.js';

const outcome = input => readTaskOutcome({ tool_calls: [{ id: 'done', function: { name: 'finish_task', arguments: JSON.stringify(input) } }] }, call => JSON.parse(call.function.arguments));
assert.deepEqual(outcome({ status: 'completed', summary: ' legacy reply ' }), { status: 'completed', summary: 'legacy reply' });
assert.deepEqual(outcome({ status: 'partial', summary: '结果', details: '  具体分析  ', limitations: '  未运行浏览器  ' }),
  { status: 'partial', summary: '结果', details: '具体分析', limitations: '未运行浏览器' });
assert.equal(outcome({ status: 'partial', summary: '结果', warnings: ' 使用前需要修复 ' }).warnings, '使用前需要修复');
for (const invalid of [{ details: {} }, { details: 'x'.repeat(24001) }, { limitations: [] }, { limitations: 'x'.repeat(4001) }, { warnings: null }, { warnings: 'x'.repeat(4001) }]) {
  assert.throws(() => outcome({ status: 'completed', summary: 'result', ...invalid }), /INVALID_TASK_OUTCOME/);
}
const finish = TOOL_DEFINITIONS.find(tool => tool.function.name === 'finish_task').function;
assert.deepEqual(finish.parameters.required, ['status', 'summary'], 'legacy summaries remain valid');
assert.match(finish.parameters.properties.limitations.description, /collapsed full reply/);
assert.match(finish.parameters.properties.warnings.description, /Always-visible essential warning/);
assert.match(finish.parameters.properties.details.description, /Important failures or actions must also be in summary\/warnings/);

for (const status of ['unverified', 'unavailable']) {
  const presentation = deliveryPresentation({ status, findings: [], reviewPending: false }, true);
  assert.equal(presentation.warning, '', 'routine verification notes stay out of the main reply');
  assert.match(presentation.details, /验证说明/);
}
const failed = deliveryPresentation({ status: 'failed', findings: [], reviewPending: false }, true);
assert.match(failed.warning, /检查没有通过/); assert.match(failed.details, /部分检查未通过/);
assert.match(deliveryPresentation({ status: 'passed', findings: [{ severity: 'high' }], reviewPending: false }, true).warning, /问题尚未解决/);
assert.deepEqual(deliveryPresentation({ status: 'passed', findings: [], reviewPending: false }, true), { warning: '', details: '' });
assert.deepEqual(deliveryPresentation({ status: 'unverified', findings: [], reviewPending: false }, false), { warning: '', details: '' });

const summary = '审查完成，发现 1 处需要关注的问题。';
const details = '## 具体分析\n\n第 194 行的计算应统一单位。\n\n```js\nconst angle = value / Math.PI;\n```';
const limitation = '仅检查代码，未运行浏览器；实际效果仍需验证。';
const history = sanitizeConversation([{ role: 'assistant', status: 'completed', content: summary, deliveryDetails: details }]);
assert(history[0].content.includes(summary)); assert(history[0].content.includes(details));
assert(!Object.hasOwn(history[0], 'deliveryDetails'), 'presentation metadata never leaks onto the provider wire');
const fork = forkPublicHistory([{ role: 'assistant', content: summary, deliveryDetails: details, reasoning_content: 'PRIVATE_REASONING', acceptance: { certification: 'PRIVATE_RECEIPT' } },
  { role: 'user', content: '继续', deliveryDetails: 'UNTRUSTED_EXTRA' }]);
assert.equal(fork[0].deliveryDetails, details);
assert(!JSON.stringify(fork).includes('PRIVATE_')); assert(!JSON.stringify(fork).includes('UNTRUSTED_EXTRA'));
assert.equal(sanitizeRunResult({ status: 'completed', content: summary, deliveryDetails: details }).deliveryDetails, details, 'saved results retain the disclosure');
assert.equal(sanitizeFinalAnswer('请解释 certification 和 scope 的含义。'), '请解释 certification 和 scope 的含义。', 'explicit technical questions are not blindly censored');

const original = globalThis.fetch;
let calls = 0;
try {
  for (const [language, status, limitations, warnings] of [['zh-CN', 'completed', limitation, ''], ['en', 'partial', 'Code inspected; browser behavior remains unverified.', 'Fix the failed input check before using this result.'], ['en', 'completed', '', '']]) {
    let requests = 0;
    globalThis.fetch = async (_url, options) => {
      requests++; calls++;
      const body = JSON.parse(options.body);
      const instructions = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
      assert.match(instructions, /Result-first delivery:/);
      assert.match(instructions, /Keep each key issue to one or two plain-language sentences/);
      assert.match(instructions, /preserve exact technical identifiers when the user explicitly asks/);
      assert.match(instructions, /NOT independently verified or accepted by the user/);
      assert.match(instructions, /Routine statements that a visual\/browser check was not performed belong in the full reply/);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'finish', type: 'function', function: {
        name: 'finish_task', arguments: JSON.stringify({ status, summary, details, ...(limitations ? { limitations } : {}), ...(warnings ? { warnings } : {}) }),
      } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
    };
    const result = await runHarness({ runId: `delivery-structured-${calls}`, taskId: 'fixture', workspacePath: '', permission: 'read-only', thinking: false,
      provider: { id: 'fixture', name: 'Fixture', vendor: 'openai', apiKey: 'test-only', baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'fixture', supportsTools: true }] },
      modelId: 'fixture', language, messages: [{ role: 'user', content: 'Summarize the known findings without running tools or making changes.' }] });
    assert.equal(result.status, status, 'presentation does not upgrade partial to completed');
    assert(result.deliveryDetails.includes(details));
    assert(result.content.startsWith(summary));
    if (limitations) { assert(result.deliveryDetails.includes(limitations)); assert(!result.content.includes(limitations), 'routine limitations are retained in the full reply'); }
    else assert.doesNotMatch(result.content, /unverified|未验证|尚未/, 'do not invent an unverified disclaimer');
    if (warnings) assert(result.content.includes(warnings), 'important failures or actions remain visible');
    assert.doesNotMatch(result.content, /验证与限制|Verification and limitations/);
    assert(!result.content.includes('const angle'), 'technical analysis is separate from the summary');
    assert.equal(requests, 1, 'presentation introduces no repair/rewrite model round');
  }
} finally { globalThis.fetch = original; }
console.log('PASS conversational handoff, routine notes in full reply, essential warnings visible, legacy replies, history/fork/persistence, honest status and no extra model calls. Synthetic provider only.');
